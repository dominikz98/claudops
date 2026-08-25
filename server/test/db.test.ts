import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { InstanceRepository } from '../src/db/instances.ts';
import { latestSchemaVersion, migrate, schemaVersion } from '../src/db/migrations.ts';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('migrations', () => {
  it('brings an empty database to the current schema', () => {
    const db = new Database(':memory:');
    expect(schemaVersion(db)).toBe(0);
    expect(migrate(db)).toBe(latestSchemaVersion);
  });

  it('is idempotent', () => {
    const db = freshDb();
    expect(migrate(db)).toBe(latestSchemaVersion);
    expect(migrate(db)).toBe(latestSchemaVersion);
  });

  it('has no status and no token column -- both live elsewhere', () => {
    const columns = freshDb()
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('instances')
      .map((row) => (row as { name: string }).name);

    expect(columns).toEqual([
      'id',
      'name',
      'image',
      'container_id',
      'repo_url',
      'repo_branch',
      'created_at',
    ]);
  });
});

describe('InstanceRepository', () => {
  let repository: InstanceRepository;

  const newInstance = {
    id: 'abc123',
    name: 'demo',
    image: 'claudops-base',
    repoUrl: 'https://github.com/dominikz98/claudops.git',
    repoBranch: 'main',
    createdAt: '2026-08-25T08:00:00.000Z',
  };

  beforeEach(() => {
    repository = new InstanceRepository(freshDb());
  });

  it('stores an instance without a container id', () => {
    expect(repository.insert(newInstance)).toEqual({ ...newInstance, containerId: null });
    expect(repository.get('abc123')?.containerId).toBeNull();
  });

  it('attaches a container id afterwards', () => {
    repository.insert(newInstance);
    repository.attachContainer('abc123', 'container-1');

    expect(repository.get('abc123')?.containerId).toBe('container-1');
  });

  it('keeps a repo-less instance', () => {
    repository.insert({ ...newInstance, repoUrl: null, repoBranch: null });

    expect(repository.get('abc123')).toMatchObject({ repoUrl: null, repoBranch: null });
  });

  it('returns undefined for an unknown id', () => {
    expect(repository.get('nope')).toBeUndefined();
  });

  it('lists newest first', () => {
    repository.insert(newInstance);
    repository.insert({ ...newInstance, id: 'def456', createdAt: '2026-08-25T09:00:00.000Z' });

    expect(repository.list().map((i) => i.id)).toEqual(['def456', 'abc123']);
  });

  it('reports whether a delete removed anything', () => {
    repository.insert(newInstance);

    expect(repository.delete('abc123')).toBe(true);
    expect(repository.delete('abc123')).toBe(false);
    expect(repository.list()).toEqual([]);
  });

  it('refuses to point two instances at the same container', () => {
    repository.insert(newInstance);
    repository.insert({ ...newInstance, id: 'def456' });
    repository.attachContainer('abc123', 'container-1');

    expect(() => repository.attachContainer('def456', 'container-1')).toThrow(/UNIQUE/);
  });

  it('rejects a duplicate id', () => {
    repository.insert(newInstance);

    expect(() => repository.insert(newInstance)).toThrow(/UNIQUE/);
  });
});
