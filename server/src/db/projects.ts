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
  image_status: string;
  image_log: string | null;
  image_built_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A column is a string as far as SQLite is concerned; a value it does not know
 *  is treated as "needs building" rather than crashing the list. */
function toImageStatus(value: string): ImageStatus {
  return (IMAGE_STATUSES as readonly string[]).includes(value)
    ? (value as ImageStatus)
    : 'pending';
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
    this.db
      .prepare(
        `INSERT INTO projects
           (id, name, repo_url, repo_branch, block_dotnet, block_playwright,
            git_token, image_status, image_log, image_built_at,
            created_at, updated_at)
         VALUES
           (@id, @name, @repoUrl, @repoBranch, @dotnet, @playwright,
            @sealedGitToken, @imageStatus, @imageLog, @imageBuiltAt,
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
        imageStatus: project.image.status,
        imageLog: project.image.log,
        imageBuiltAt: project.image.builtAt,
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
    if (changes.imageStatus !== undefined) {
      set('image_status', 'imageStatus', changes.imageStatus);
      // The log described the image that is now out of date; keeping it would
      // show the output of a build nobody can reach any more.
      set('image_log', 'imageLog', null);
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
