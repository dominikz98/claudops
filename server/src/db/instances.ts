import type { Database } from 'better-sqlite3';

/** An instance as it is stored -- identity only, no status and no secrets.
 *
 *  `repoUrl` and `repoBranch` are a snapshot of what the container was given,
 *  not a view onto the project: editing the project afterwards must not rewrite
 *  what an already running instance was started from. `projectId` is null only
 *  for rows created before projects existed. */
export interface InstanceRecord {
  id: string;
  name: string;
  image: string;
  containerId: string | null;
  projectId: string | null;
  repoUrl: string | null;
  repoBranch: string | null;
  createdAt: string;
}

export interface NewInstance {
  id: string;
  name: string;
  image: string;
  projectId: string | null;
  repoUrl: string | null;
  repoBranch: string | null;
  createdAt: string;
}

interface InstanceRow {
  id: string;
  name: string;
  image: string;
  container_id: string | null;
  project_id: string | null;
  repo_url: string | null;
  repo_branch: string | null;
  created_at: string;
}

function toRecord(row: InstanceRow): InstanceRecord {
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    containerId: row.container_id,
    projectId: row.project_id,
    repoUrl: row.repo_url,
    repoBranch: row.repo_branch,
    createdAt: row.created_at,
  };
}

export class InstanceRepository {
  constructor(private readonly db: Database) {}

  insert(instance: NewInstance): InstanceRecord {
    this.db
      .prepare(
        `INSERT INTO instances
           (id, name, image, container_id, project_id, repo_url, repo_branch, created_at)
         VALUES (@id, @name, @image, NULL, @projectId, @repoUrl, @repoBranch, @createdAt)`,
      )
      .run(instance);

    return { ...instance, containerId: null };
  }

  attachContainer(id: string, containerId: string): void {
    this.db.prepare('UPDATE instances SET container_id = ? WHERE id = ?').run(containerId, id);
  }

  /**
   * Forgets the container of an instance whose container is gone -- what the
   * startup reconcile writes for a row Docker has nothing to match. Still no
   * status column: the row keeps its identity and reports `missing`, and the
   * unique index is free again for a container id Docker may reuse.
   *
   * Returns whether anything changed, so the reconcile can report what it did.
   */
  detachContainer(id: string): boolean {
    return (
      this.db
        .prepare('UPDATE instances SET container_id = NULL WHERE id = ? AND container_id IS NOT NULL')
        .run(id).changes > 0
    );
  }

  get(id: string): InstanceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as
      | InstanceRow
      | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  list(): InstanceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM instances ORDER BY created_at DESC, id DESC')
      .all() as InstanceRow[];
    return rows.map(toRecord);
  }

  /** Returns whether a row was actually removed, so the caller can tell a
   *  delete from a no-op. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM instances WHERE id = ?').run(id).changes > 0;
  }
}
