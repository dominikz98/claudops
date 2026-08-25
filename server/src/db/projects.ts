import type { Database } from 'better-sqlite3';

/** The optional layers a project image gets in #7. Stored now, so the flags are
 *  set by the time there is a build that reads them. */
export interface BuildingBlocks {
  dotnet: boolean;
  playwright: boolean;
}

/**
 * A project as it is stored. `sealedGitToken` is the ciphertext from
 * src/secrets/cipher.ts -- this layer never sees the PAT itself, which keeps
 * "who can decrypt" a question about one module rather than about the database.
 */
export interface ProjectRecord {
  id: string;
  name: string;
  repoUrl: string;
  repoBranch: string | null;
  buildingBlocks: BuildingBlocks;
  sealedGitToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewProject = ProjectRecord;

/**
 * The fields a PATCH actually carried. A missing key keeps the stored value,
 * which is what makes "leave the token field empty to keep the token" work --
 * `null` is the explicit removal.
 */
export interface ProjectChanges {
  name?: string;
  repoUrl?: string;
  repoBranch?: string | null;
  buildingBlocks?: BuildingBlocks;
  sealedGitToken?: string | null;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  repo_url: string;
  repo_branch: string | null;
  block_dotnet: number;
  block_playwright: number;
  git_token: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    repoBranch: row.repo_branch,
    buildingBlocks: {
      dotnet: row.block_dotnet !== 0,
      playwright: row.block_playwright !== 0,
    },
    sealedGitToken: row.git_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  insert(project: NewProject): ProjectRecord {
    this.db
      .prepare(
        `INSERT INTO projects
           (id, name, repo_url, repo_branch, block_dotnet, block_playwright,
            git_token, created_at, updated_at)
         VALUES
           (@id, @name, @repoUrl, @repoBranch, @dotnet, @playwright,
            @sealedGitToken, @createdAt, @updatedAt)`,
      )
      .run({
        id: project.id,
        name: project.name,
        repoUrl: project.repoUrl,
        repoBranch: project.repoBranch,
        dotnet: project.buildingBlocks.dotnet ? 1 : 0,
        playwright: project.buildingBlocks.playwright ? 1 : 0,
        sealedGitToken: project.sealedGitToken,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });

    return project;
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Sorted by name rather than by age: this list is a picker, and a project is
   *  looked for by what it is called. */
  list(): ProjectRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
      .all() as ProjectRow[];
    return rows.map(toRecord);
  }

  /** `undefined` for an id that does not exist -- the caller distinguishes a
   *  failed update from an update that changed nothing. */
  update(id: string, changes: ProjectChanges): ProjectRecord | undefined {
    const assignments = ['updated_at = @updatedAt'];
    const params: Record<string, string | number | null> = {
      id,
      updatedAt: changes.updatedAt,
    };

    const set = (column: string, key: string, value: string | number | null): void => {
      assignments.push(`${column} = @${key}`);
      params[key] = value;
    };

    if (changes.name !== undefined) set('name', 'name', changes.name);
    if (changes.repoUrl !== undefined) set('repo_url', 'repoUrl', changes.repoUrl);
    if (changes.repoBranch !== undefined) set('repo_branch', 'repoBranch', changes.repoBranch);
    if (changes.buildingBlocks !== undefined) {
      set('block_dotnet', 'dotnet', changes.buildingBlocks.dotnet ? 1 : 0);
      set('block_playwright', 'playwright', changes.buildingBlocks.playwright ? 1 : 0);
    }
    if (changes.sealedGitToken !== undefined) {
      set('git_token', 'sealedGitToken', changes.sealedGitToken);
    }

    const changed = this.db
      .prepare(`UPDATE projects SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params).changes;

    return changed === 0 ? undefined : this.get(id);
  }

  /** Returns whether a row was actually removed, so the caller can tell a
   *  delete from a no-op. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  /** How many instances still point at this project. What makes the delete
   *  refuse with a number instead of a bare conflict. */
  countInstances(id: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM instances WHERE project_id = ?')
      .get(id) as { count: number };
    return row.count;
  }

  /** The same count for every project at once, for the list. */
  instanceCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT project_id AS id, COUNT(*) AS count
           FROM instances
          WHERE project_id IS NOT NULL
          GROUP BY project_id`,
      )
      .all() as { id: string; count: number }[];
    return new Map(rows.map((row) => [row.id, row.count]));
  }
}
