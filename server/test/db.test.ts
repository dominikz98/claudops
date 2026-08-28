import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.ts';
import { InstanceRepository } from '../src/db/instances.ts';
import { latestSchemaVersion, migrate, schemaVersion } from '../src/db/migrations.ts';
import { ProjectRepository, type NewProject } from '../src/db/projects.ts';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .map((row) => (row as { name: string }).name);
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

  it('gives instances no status and no token column -- both live elsewhere', () => {
    expect(columnsOf(freshDb(), 'instances')).toEqual([
      'id',
      'name',
      'image',
      'container_id',
      'repo_url',
      'repo_branch',
      'created_at',
      // Added by migration 2, hence last: SQLite appends.
      'project_id',
      // Migration 4. Not a status either: a decision the container is started
      // with, which nothing but this table remembers across a restart.
      'model',
      'effort',
    ]);
  });

  it('leaves an instance from before migration 4 without a model or effort', () => {
    const db = new Database(':memory:');
    // The schema as it stood after migration 2, plus one row -- what an
    // upgrade of a running installation actually finds.
    db.exec(`CREATE TABLE instances (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT NOT NULL,
               container_id TEXT, repo_url TEXT, repo_branch TEXT,
               created_at TEXT NOT NULL, project_id TEXT);
             INSERT INTO instances (id, name, image, created_at)
               VALUES ('old', 'from-before', 'claudops-base', '2026-08-01T00:00:00.000Z');`);
    db.pragma('user_version = 3');

    migrate(db);

    const row = new InstanceRepository(db).get('old');
    expect(row?.name).toBe('from-before');
    expect(row?.model).toBeNull();
    expect(row?.effort).toBeNull();
  });

  it('keeps the project PAT in a single column and nothing else secret', () => {
    expect(columnsOf(freshDb(), 'projects')).toEqual([
      'id',
      'name',
      'repo_url',
      'repo_branch',
      'block_dotnet',
      'block_playwright',
      'git_token',
      'created_at',
      'updated_at',
      // Migration 3, appended: the image state.
      'image_status',
      'image_log',
      'image_built_at',
    ]);
  });

  it('leaves a project from before project images needing a build', () => {
    const db = new Database(':memory:');
    // Stop one short of the current schema and write a project the old way, so
    // this is a real upgrade rather than a fresh file.
    migrate(db);
    db.prepare(
      `INSERT INTO projects
         (id, name, repo_url, repo_branch, block_dotnet, block_playwright,
          git_token, created_at, updated_at)
       VALUES ('old', 'legacy', 'https://host/x.git', NULL, 0, 0, NULL, 'then', 'then')`,
    ).run();

    expect(new ProjectRepository(db).get('old')?.image).toEqual({
      status: 'pending',
      log: null,
      builtAt: null,
    });
  });
});

describe('InstanceRepository', () => {
  let repository: InstanceRepository;

  const newInstance = {
    id: 'abc123',
    name: 'demo',
    image: 'claudops-project-p1',
    projectId: null,
    repoUrl: 'https://github.com/dominikz98/claudops.git',
    repoBranch: 'main',
    model: null,
    effort: null,
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

  it('records a model and an effort, and takes them back to null', () => {
    repository.insert({ ...newInstance, model: 'haiku', effort: 'low' });
    expect(repository.get('abc123')).toMatchObject({ model: 'haiku', effort: 'low' });

    repository.setModelEffort('abc123', 'opus', 'xhigh');
    expect(repository.get('abc123')).toMatchObject({ model: 'opus', effort: 'xhigh' });

    // `null` is a value here, not "leave it alone" -- the service has already
    // decided what stays and what changes by the time it calls this.
    repository.setModelEffort('abc123', null, null);
    expect(repository.get('abc123')).toMatchObject({ model: null, effort: null });
  });

  it('forgets a container that is gone, and says whether it had one', () => {
    repository.insert(newInstance);
    repository.attachContainer('abc123', 'container-1');

    expect(repository.detachContainer('abc123')).toBe(true);
    expect(repository.get('abc123')?.containerId).toBeNull();
    // The row survives -- it is somebody's instance, and only the container
    // behind it is gone.
    expect(repository.detachContainer('abc123')).toBe(false);
    expect(repository.get('abc123')).toBeDefined();
  });

  it('frees the container id for reuse once it is detached', () => {
    repository.insert(newInstance);
    repository.insert({ ...newInstance, id: 'def456' });
    repository.attachContainer('abc123', 'container-1');
    repository.detachContainer('abc123');

    // Docker reuses ids after a prune, and the unique index would otherwise
    // keep the next instance from ever taking that one.
    expect(() => repository.attachContainer('def456', 'container-1')).not.toThrow();
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

describe('ProjectRepository', () => {
  let projects: ProjectRepository;

  const newProject: NewProject = {
    id: 'proj-1',
    name: 'claudops',
    repoUrl: 'https://github.com/dominikz98/claudops.git',
    repoBranch: 'main',
    buildingBlocks: { dotnet: true, playwright: false },
    sealedGitToken: 'v1:sealed-blob',
    image: { status: 'pending', log: null, builtAt: null },
    createdAt: '2026-08-25T08:00:00.000Z',
    updatedAt: '2026-08-25T08:00:00.000Z',
  };

  beforeEach(() => {
    projects = new ProjectRepository(freshDb());
  });

  it('stores and returns a project unchanged', () => {
    expect(projects.insert(newProject)).toEqual(newProject);
    expect(projects.get('proj-1')).toEqual(newProject);
  });

  it('keeps a project without a branch and without a token', () => {
    projects.insert({ ...newProject, repoBranch: null, sealedGitToken: null });

    expect(projects.get('proj-1')).toMatchObject({ repoBranch: null, sealedGitToken: null });
  });

  it('returns undefined for an unknown id', () => {
    expect(projects.get('nope')).toBeUndefined();
  });

  it('lists by name, ignoring case -- the list is a picker', () => {
    projects.insert({ ...newProject, id: 'p2', name: 'zulu' });
    projects.insert({ ...newProject, id: 'p1', name: 'alpha' });
    projects.insert({ ...newProject, id: 'p3', name: 'Bravo' });

    expect(projects.list().map((project) => project.name)).toEqual(['alpha', 'Bravo', 'zulu']);
  });

  it('rejects a duplicate name', () => {
    projects.insert(newProject);

    expect(() => projects.insert({ ...newProject, id: 'other' })).toThrow(/UNIQUE/);
  });

  describe('update', () => {
    beforeEach(() => {
      projects.insert(newProject);
    });

    it('changes only what it was given', () => {
      const updated = projects.update('proj-1', {
        name: 'renamed',
        updatedAt: '2026-08-25T09:00:00.000Z',
      });

      expect(updated).toEqual({
        ...newProject,
        name: 'renamed',
        updatedAt: '2026-08-25T09:00:00.000Z',
      });
    });

    it('removes the token when handed null, and keeps it when handed nothing', () => {
      expect(
        projects.update('proj-1', { sealedGitToken: null, updatedAt: 'x' })?.sealedGitToken,
      ).toBeNull();
      expect(projects.update('proj-1', { updatedAt: 'y' })?.sealedGitToken).toBeNull();
    });

    it('replaces both building block flags together', () => {
      const updated = projects.update('proj-1', {
        buildingBlocks: { dotnet: false, playwright: true },
        updatedAt: 'z',
      });

      expect(updated?.buildingBlocks).toEqual({ dotnet: false, playwright: true });
    });

    it('reports an unknown id as undefined rather than inventing a row', () => {
      expect(projects.update('nope', { name: 'x', updatedAt: 'z' })).toBeUndefined();
    });
  });

  it('reports whether a delete removed anything', () => {
    projects.insert(newProject);

    expect(projects.delete('proj-1')).toBe(true);
    expect(projects.delete('proj-1')).toBe(false);
  });

  describe('the image state', () => {
    beforeEach(() => {
      projects.insert(newProject);
    });

    it('records a finished build without touching updatedAt', () => {
      projects.setImageState('proj-1', 'ready', 'the log', '2026-08-25T09:00:00.000Z');

      expect(projects.get('proj-1')).toMatchObject({
        image: { status: 'ready', log: 'the log', builtAt: '2026-08-25T09:00:00.000Z' },
        // A build is the server talking to itself; it is not an edit of the
        // project, so this stays where the last real change left it.
        updatedAt: '2026-08-25T08:00:00.000Z',
      });
    });

    it('keeps the previous builtAt when a rebuild fails', () => {
      projects.setImageState('proj-1', 'ready', '', '2026-08-25T09:00:00.000Z');
      projects.setImageState('proj-1', 'failed', 'the reason');

      expect(projects.get('proj-1')?.image).toEqual({
        status: 'failed',
        log: 'the reason',
        builtAt: '2026-08-25T09:00:00.000Z',
      });
    });

    it('reports whether the row was there', () => {
      expect(projects.setImageState('proj-1', 'building', null)).toBe(true);
      expect(projects.setImageState('nope', 'building', null)).toBe(false);
    });

    it('drops the log when a changed environment invalidates the image', () => {
      projects.setImageState('proj-1', 'ready', 'output of the old image');

      projects.update('proj-1', {
        buildingBlocks: { dotnet: true, playwright: true },
        imageStatus: 'pending',
        updatedAt: '2026-08-25T10:00:00.000Z',
      });

      expect(projects.get('proj-1')?.image).toMatchObject({ status: 'pending', log: null });
    });

    it('finds the projects waiting for a build, oldest first', () => {
      projects.insert({ ...newProject, id: 'proj-2', name: 'later', createdAt: 'z' });
      projects.insert({ ...newProject, id: 'proj-3', name: 'done' });
      projects.setImageState('proj-3', 'ready', '');
      projects.setImageState('proj-1', 'building', null);

      expect(projects.idsWithImageStatus('pending')).toEqual(['proj-2']);
      expect(projects.idsWithImageStatus('pending', 'building')).toEqual(['proj-1', 'proj-2']);
      expect(projects.idsWithImageStatus()).toEqual([]);
    });
  });

  describe('instance counts', () => {
    let instances: InstanceRepository;

    const instanceOf = (id: string, projectId: string | null) => ({
      id,
      name: id,
      image: 'claudops-project-x',
      projectId,
      repoUrl: null,
      repoBranch: null,
      model: null,
      effort: null,
      createdAt: '2026-08-25T08:00:00.000Z',
    });

    beforeEach(() => {
      const db = freshDb();
      projects = new ProjectRepository(db);
      instances = new InstanceRepository(db);
      projects.insert(newProject);
      projects.insert({ ...newProject, id: 'proj-2', name: 'other' });
    });

    it('counts the instances of one project', () => {
      instances.insert(instanceOf('i1', 'proj-1'));
      instances.insert(instanceOf('i2', 'proj-1'));
      instances.insert(instanceOf('i3', 'proj-2'));
      // A row from before projects existed must not be counted anywhere.
      instances.insert(instanceOf('i4', null));

      expect(projects.countInstances('proj-1')).toBe(2);
      expect(projects.countInstances('proj-2')).toBe(1);
      expect(projects.countInstances('nope')).toBe(0);
      expect([...projects.instanceCounts()]).toEqual([
        ['proj-1', 2],
        ['proj-2', 1],
      ]);
    });

    it('has no entry at all for a project nothing points at', () => {
      expect(projects.instanceCounts().get('proj-1')).toBeUndefined();
    });
  });

  it('lets the foreign key catch a delete the service did not check', () => {
    // openDatabase, not freshDb: `foreign_keys = ON` is set there and nowhere
    // else, so a test on a bare `new Database()` would see the delete succeed
    // (knowledge/sqlite-fk-needs-the-pragma-in-tests.md).
    const db = openDatabase(':memory:');
    new ProjectRepository(db).insert(newProject);
    new InstanceRepository(db).insert({
      id: 'i1',
      name: 'demo',
      image: 'claudops-project-proj-1',
      projectId: 'proj-1',
      repoUrl: null,
      repoBranch: null,
      model: null,
      effort: null,
      createdAt: '2026-08-25T08:00:00.000Z',
    });

    expect(() => new ProjectRepository(db).delete('proj-1')).toThrow(/FOREIGN KEY/);
  });
});
