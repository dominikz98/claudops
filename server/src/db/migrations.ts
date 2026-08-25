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
