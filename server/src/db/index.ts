import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations.ts';

export type { Database } from 'better-sqlite3';

/**
 * Open the database and bring it up to the current schema. `:memory:` is
 * accepted for tests and skips the directory handling.
 */
export function openDatabase(file: string): Database.Database {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new Database(file);
  // WAL survives a crash better and lets a reader in while a write is open.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
