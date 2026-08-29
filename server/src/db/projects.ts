import type { Database } from 'better-sqlite3';

/** The optional layers a project image is built with. */
export interface BuildingBlocks {
  dotnet: boolean;
  playwright: boolean;
}

/**
 * Where a project's image stands.
 *
 * `pending` is "needs building" -- fresh project, changed building blocks, or a
 * rebuild somebody asked for. `failed` stays until the next explicit build, so a
 * broken Dockerfile is not retried in a loop.
 */
export type ImageStatus = 'pending' | 'building' | 'ready' | 'failed';

export const IMAGE_STATUSES: readonly ImageStatus[] = [
  'pending',
  'building',
  'ready',
  'failed',
];

/** The outcome of one build: the status plus what is worth keeping about it. */
export interface ImageState {
  status: ImageStatus;
  /** The daemon's output, truncated by the builder. `null` before the first
   *  build. */
  log: string | null;
  /** When the image last became `ready`. Survives a later failed rebuild, so
   *  "there is an image, and it is from before" stays readable. */
  builtAt: string | null;
}

/**
 * A project as it is stored. `sealedGitToken` and every value in `env` are
 * ciphertext from src/secrets/cipher.ts -- this layer never sees a plaintext
 * secret, which keeps "who can decrypt" a question about one module rather than
 * about the database.
 */
export interface ProjectRecord {
  id: string;
  name: string;
  repoUrl: string;
  repoBranch: string | null;
  buildingBlocks: BuildingBlocks;
  sealedGitToken: string | null;
  /** Variable name to sealed value. The name is in the clear on purpose: it is
   *  what the API lists and what a PATCH addresses one variable by. */
  env: Record<string, string>;
  /** Hosts and CIDRs this project's instances may reach, on top of the
   *  server-wide list. Not secret, and read and written as one list. */
  egressHosts: string[];
  /** State of the project's image. Written by the builder, never by a PATCH. */
  image: ImageState;
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
  /**
   * Variables to write, by name: a sealed value sets one, `null` removes it,
   * and a name that is not mentioned keeps whatever it had. The same reading as
   * `sealedGitToken`, one level down -- a PATCH that changes one variable must
   * not clear the other five.
   */
  env?: Record<string, string | null>;
  /** The whole list, replaced. Unlike `env` there is nothing to address a
   *  single entry by, and an empty array is the legitimate way to clear it. */
  egressHosts?: string[];
  /**
   * Only ever `pending`: changing the building blocks invalidates the image, and
   * that belongs in the same statement as the change itself. Every other status
   * comes from the builder through `setImageStatus`, which leaves `updatedAt`
   * alone -- a finished build is not an edit of the project.
   */
  imageStatus?: 'pending';
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
  egress_hosts: string;
  image_status: string;
  image_log: string | null;
  image_built_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EnvRow {
  project_id: string;
  name: string;
  value: string;
}

/** The column is one string; the list is what every caller wants. Empty entries
 *  are dropped rather than handed on as `''`, which the firewall script would
 *  skip anyway. */
function toHosts(column: string): string[] {
  return column
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '');
}

/** A column is a string as far as SQLite is concerned; a value it does not know
 *  is treated as "needs building" rather than crashing the list. */
function toImageStatus(value: string): ImageStatus {
  return (IMAGE_STATUSES as readonly string[]).includes(value)
    ? (value as ImageStatus)
    : 'pending';
}

function toRecord(row: ProjectRow, env: Record<string, string>): ProjectRecord {
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
    env,
    egressHosts: toHosts(row.egress_hosts),
    image: {
      status: toImageStatus(row.image_status),
      log: row.image_log,
      builtAt: row.image_built_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  insert(project: NewProject): ProjectRecord {
    // One transaction: a project whose row exists without its variables would
    // start instances that are missing half their environment.
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects
             (id, name, repo_url, repo_branch, block_dotnet, block_playwright,
              git_token, egress_hosts, image_status, image_log, image_built_at,
              created_at, updated_at)
           VALUES
             (@id, @name, @repoUrl, @repoBranch, @dotnet, @playwright,
              @sealedGitToken, @egressHosts, @imageStatus, @imageLog, @imageBuiltAt,
              @createdAt, @updatedAt)`,
        )
        .run({
          id: project.id,
          name: project.name,
          repoUrl: project.repoUrl,
          repoBranch: project.repoBranch,
          dotnet: project.buildingBlocks.dotnet ? 1 : 0,
          playwright: project.buildingBlocks.playwright ? 1 : 0,
          sealedGitToken: project.sealedGitToken,
          egressHosts: project.egressHosts.join(','),
          imageStatus: project.image.status,
          imageLog: project.image.log,
          imageBuiltAt: project.image.builtAt,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        });

      this.writeEnv(project.id, project.env);
    })();

    return project;
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row === undefined ? undefined : toRecord(row, this.env(id));
  }

  /** Sorted by name rather than by age: this list is a picker, and a project is
   *  looked for by what it is called. */
  list(): ProjectRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
      .all() as ProjectRow[];

    // One query for every project's variables rather than one per project: this
    // list is read on every beat of the projects page.
    const env = this.allEnv();
    return rows.map((row) => toRecord(row, env.get(row.id) ?? {}));
  }

  /** One project's variables, name to sealed value. */
  env(projectId: string): Record<string, string> {
    const rows = this.db
      .prepare('SELECT * FROM project_env WHERE project_id = ? ORDER BY name')
      .all(projectId) as EnvRow[];
    return Object.fromEntries(rows.map((row) => [row.name, row.value]));
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
    if (changes.egressHosts !== undefined) {
      set('egress_hosts', 'egressHosts', changes.egressHosts.join(','));
    }
    if (changes.imageStatus !== undefined) {
      set('image_status', 'imageStatus', changes.imageStatus);
      // The log described the image that is now out of date; keeping it would
      // show the output of a build nobody can reach any more.
      set('image_log', 'imageLog', null);
    }

    // The column update and the variables in one transaction, for the reason
    // `insert` has one: half a PATCH is a project nobody asked for.
    const changed = this.db.transaction(() => {
      const rows = this.db
        .prepare(`UPDATE projects SET ${assignments.join(', ')} WHERE id = @id`)
        .run(params).changes;
      if (rows > 0 && changes.env !== undefined) this.writeEnv(id, changes.env);
      return rows;
    })();

    return changed === 0 ? undefined : this.get(id);
  }

  /** Returns whether a row was actually removed, so the caller can tell a
   *  delete from a no-op. */
  delete(id: string): boolean {
    // The variables go by hand rather than through ON DELETE CASCADE: the
    // constraint is only enforced where `foreign_keys = ON` was set on the
    // connection, and a caller that opened the file without it would leave
    // sealed values behind for an id nothing points at
    // (knowledge/sqlite-fk-needs-the-pragma-in-tests.md).
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM project_env WHERE project_id = ?').run(id);
      return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
    })();
  }

  /**
   * Writes the outcome of a build. Deliberately not part of `update`: a build
   * is the server talking to itself, and letting it bump `updatedAt` would make
   * every project look edited every time an image was rebuilt.
   *
   * `builtAt` left out keeps the stored one, so a failed rebuild does not erase
   * when the working image was made.
   */
  setImageState(id: string, status: ImageStatus, log: string | null, builtAt?: string): boolean {
    const assignments = ['image_status = @status', 'image_log = @log'];
    const params: Record<string, string | null> = { id, status, log };

    if (builtAt !== undefined) {
      assignments.push('image_built_at = @builtAt');
      params.builtAt = builtAt;
    }

    return (
      this.db
        .prepare(`UPDATE projects SET ${assignments.join(', ')} WHERE id = @id`)
        .run(params).changes > 0
    );
  }

  /** Ids of the projects in one of these image states, oldest first -- what the
   *  startup sweep works through. */
  idsWithImageStatus(...statuses: ImageStatus[]): string[] {
    if (statuses.length === 0) return [];

    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id FROM projects
          WHERE image_status IN (${placeholders})
          ORDER BY created_at`,
      )
      .all(...statuses) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** How many instances still point at this project. What makes the delete
   *  refuse with a number instead of a bare conflict. */
  countInstances(id: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM instances WHERE project_id = ?')
      .get(id) as { count: number };
    return row.count;
  }

  /**
   * Applies a set of variable changes: a sealed value writes one, `null` removes
   * it, and a name that is not in `changes` is left alone.
   *
   * Private, and always called inside a transaction by the two that do: a
   * variable is part of the project, not a resource of its own, and letting it
   * be written separately would invite exactly the half-applied PATCH the
   * transaction exists to prevent.
   */
  private writeEnv(projectId: string, changes: Record<string, string | null>): void {
    const upsert = this.db.prepare(
      `INSERT INTO project_env (project_id, name, value) VALUES (?, ?, ?)
         ON CONFLICT (project_id, name) DO UPDATE SET value = excluded.value`,
    );
    const remove = this.db.prepare('DELETE FROM project_env WHERE project_id = ? AND name = ?');

    for (const [name, value] of Object.entries(changes)) {
      if (value === null) remove.run(projectId, name);
      else upsert.run(projectId, name, value);
    }
  }

  /** Every project's variables at once, for the list. */
  private allEnv(): Map<string, Record<string, string>> {
    const rows = this.db
      .prepare('SELECT * FROM project_env ORDER BY project_id, name')
      .all() as EnvRow[];

    const byProject = new Map<string, Record<string, string>>();
    for (const row of rows) {
      const env = byProject.get(row.project_id) ?? {};
      env[row.name] = row.value;
      byProject.set(row.project_id, env);
    }
    return byProject;
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
