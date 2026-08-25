import type { Database } from 'better-sqlite3';

/**
 * Schema migrations, applied in order. `user_version` records how far a
 * database got, so an existing file is upgraded rather than recreated.
 */
const MIGRATIONS: readonly string[] = [
  // 1 -- instances. No status column on purpose: the truth about a container
  // is the Docker API, this table only holds the identity (see the join in
  // instances/service.ts). No token column either -- secrets never land here.
  `CREATE TABLE instances (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     image        TEXT NOT NULL,
     container_id TEXT,
     repo_url     TEXT,
     repo_branch  TEXT,
     created_at   TEXT NOT NULL
   );
   CREATE UNIQUE INDEX instances_container_id ON instances (container_id)
     WHERE container_id IS NOT NULL;`,

  // 2 -- projects, the template an instance is created from. `git_token` holds
  // the sealed blob from src/secrets/cipher.ts, never a readable PAT -- the one
  // secret in this file, and only because a template outlives its instances.
  //
  // `project_id` stays nullable: SQLite cannot add a NOT NULL column without a
  // default, and rows from before this migration have no project to point at.
  // The service requires one on create; an old row simply shows none.
  //
  // instances.repo_url and repo_branch stay where they are. They are a snapshot
  // of what the container was actually given, so editing a project later cannot
  // rewrite the history of an instance already running.
  `CREATE TABLE projects (
     id               TEXT PRIMARY KEY,
     name             TEXT NOT NULL UNIQUE,
     repo_url         TEXT NOT NULL,
     repo_branch      TEXT,
     block_dotnet     INTEGER NOT NULL DEFAULT 0,
     block_playwright INTEGER NOT NULL DEFAULT 0,
     git_token        TEXT,
     created_at       TEXT NOT NULL,
     updated_at       TEXT NOT NULL
   );
   ALTER TABLE instances ADD COLUMN project_id TEXT REFERENCES projects (id);
   CREATE INDEX instances_project_id ON instances (project_id);`,

  // 3 -- the project image. The deliberate exception to "Docker holds the
  // state, this file holds the identity": a build that failed leaves no Docker
  // object behind to ask, so its status and its log exist nowhere else. What
  // Docker still owns is whether the image is there -- an instance start fails
  // with ImageNotFoundError regardless of what this column says.
  //
  // 'pending' as the default is what makes an upgrade work: every project that
  // existed before this migration has no image yet and gets built on the next
  // start.
  `ALTER TABLE projects ADD COLUMN image_status   TEXT NOT NULL DEFAULT 'pending';
   ALTER TABLE projects ADD COLUMN image_log      TEXT;
   ALTER TABLE projects ADD COLUMN image_built_at TEXT;`,
];

export function schemaVersion(db: Database): number {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

export function migrate(db: Database): number {
  const from = schemaVersion(db);

  for (let version = from; version < MIGRATIONS.length; version++) {
    const statement = MIGRATIONS[version];
    if (statement === undefined) continue;

    // DDL plus the version bump in one transaction: a crash halfway through
    // must not leave a half-migrated file behind.
    db.exec('BEGIN');
    try {
      db.exec(statement);
      db.pragma(`user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return schemaVersion(db);
}

export const latestSchemaVersion = MIGRATIONS.length;
