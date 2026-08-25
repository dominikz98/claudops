import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { InstanceEnvConfig } from '../src/config.ts';
import { InstanceRepository } from '../src/db/instances.ts';
import { migrate } from '../src/db/migrations.ts';
import {
  ContainerNotRunningError,
  DockerUnavailableError,
  ImageNotFoundError,
} from '../src/docker/engine.ts';
import {
  ContainerMissingError,
  InstanceNotFoundError,
  InstanceService,
  MISSING_STATUS,
} from '../src/instances/service.ts';
import { ProjectRepository } from '../src/db/projects.ts';
import {
  ProjectNotFoundError,
  ProjectService,
  type CreateProjectInput,
} from '../src/projects/service.ts';
import { SecretUndecryptableError } from '../src/secrets/cipher.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { TEST_REPO_URL, testCipher } from './fixtures.ts';

const instanceEnv: InstanceEnvConfig = {
  claudeOauthToken: 'oauth-token',
  gitUserName: 'claudops',
  gitUserEmail: 'claudops@example.invalid',
};

describe('InstanceService', () => {
  let repository: InstanceRepository;
  let projectRepository: ProjectRepository;
  let projects: ProjectService;
  let engine: FakeDockerEngine;
  let service: InstanceService;
  let ids: string[];
  /** The project every instance in these tests is created from. */
  let projectId: string;

  /** Ids come back from create, so they stay whatever the service generated;
   *  the counter only keeps the unique name unique. */
  let projectCount = 0;
  const addProject = (input: Partial<CreateProjectInput> = {}): string => {
    projectCount += 1;
    return projects.create({
      name: `project-${String(projectCount)}`,
      repoUrl: TEST_REPO_URL,
      ...input,
    }).id;
  };

  beforeEach(() => {
    const db = new Database(':memory:');
    migrate(db);
    repository = new InstanceRepository(db);
    projectRepository = new ProjectRepository(db);
    projects = new ProjectService(projectRepository, { cipher: testCipher() });
    engine = new FakeDockerEngine();
    ids = ['id-1', 'id-2', 'id-3'];
    service = new InstanceService(repository, engine, {
      baseImage: 'claudops-base',
      instanceEnv,
      projects,
      generateId: () => ids.shift() ?? 'exhausted',
      now: () => new Date('2026-08-25T08:00:00.000Z'),
    });
    projectId = addProject({ name: 'demo-project' });
  });

  describe('create', () => {
    it('starts a labelled container and records the instance', async () => {
      const instance = await service.create({ name: 'demo', projectId });

      expect(instance).toMatchObject({
        id: 'id-1',
        name: 'demo',
        image: 'claudops-base',
        containerId: 'container-1',
        projectId,
        status: 'running',
        createdAt: '2026-08-25T08:00:00.000Z',
      });
      expect(engine.specFor('id-1')).toMatchObject({
        name: 'claudops-id-1',
        image: 'claudops-base',
        labels: { 'claudops.instance': 'id-1' },
      });
      expect(repository.get('id-1')?.containerId).toBe('container-1');
    });

    it('takes repo, branch and PAT from the project, decrypted', async () => {
      const id = addProject({
        name: 'private-project',
        repoUrl: 'https://github.com/dominikz98/private.git',
        repoBranch: 'feature/dz/3',
        gitToken: 'pat-secret',
      });

      await service.create({ name: 'demo', projectId: id });

      expect(engine.specFor('id-1')?.env).toEqual({
        REPO_URL: 'https://github.com/dominikz98/private.git',
        REPO_BRANCH: 'feature/dz/3',
        GIT_TOKEN: 'pat-secret',
        GIT_USER_NAME: 'claudops',
        GIT_USER_EMAIL: 'claudops@example.invalid',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      });
    });

    it('snapshots repo and branch onto the instance, so a later edit cannot rewrite them', async () => {
      const id = addProject({ name: 'moving', repoUrl: 'https://host/one.git', repoBranch: 'old' });

      await service.create({ name: 'demo', projectId: id });
      projects.update(id, { repoUrl: 'https://host/two.git', repoBranch: 'new' });

      expect(repository.get('id-1')).toMatchObject({
        projectId: id,
        repoUrl: 'https://host/one.git',
        repoBranch: 'old',
      });
    });

    it('never sets an ANTHROPIC_API_KEY next to the OAuth token', async () => {
      await service.create({ name: 'demo', projectId });

      expect(Object.keys(engine.specFor('id-1')?.env ?? {})).not.toContain('ANTHROPIC_API_KEY');
    });

    it('omits variables that were not configured', async () => {
      const bare = new InstanceService(repository, engine, {
        baseImage: 'claudops-base',
        instanceEnv: {
          claudeOauthToken: undefined,
          gitUserName: undefined,
          gitUserEmail: undefined,
        },
        projects,
        generateId: () => 'id-bare',
      });

      await bare.create({ name: 'demo', projectId });

      // The repository is the project's, so REPO_URL stays; everything the
      // server was not told is absent rather than empty.
      expect(engine.specFor('id-bare')?.env).toEqual({ REPO_URL: TEST_REPO_URL });
    });

    it('keeps no token in the returned instance or the database', async () => {
      const id = addProject({ name: 'with-pat', gitToken: 'pat-secret' });

      const instance = await service.create({ name: 'demo', projectId: id });

      expect(JSON.stringify(instance)).not.toContain('pat-secret');
      expect(JSON.stringify(repository.get('id-1'))).not.toContain('pat-secret');
    });

    it('refuses an unknown project without leaving a row behind', async () => {
      await expect(service.create({ name: 'demo', projectId: 'nope' })).rejects.toThrow(
        ProjectNotFoundError,
      );
      expect(repository.list()).toEqual([]);
      expect(engine.containers.size).toBe(0);
    });

    it('refuses a project whose PAT no longer decrypts', async () => {
      const id = addProject({ name: 'stale-key', gitToken: 'pat-secret' });
      // What a rotated CLAUDOPS_SECRET_KEY looks like from here.
      projectRepository.update(id, { sealedGitToken: 'v1:not-mine', updatedAt: 'now' });

      await expect(service.create({ name: 'demo', projectId: id })).rejects.toThrow(
        SecretUndecryptableError,
      );
      expect(repository.list()).toEqual([]);
    });

    it('rolls the row back when the container cannot be started', async () => {
      engine.failNextRun = new Error('no space left on device');

      await expect(service.create({ name: 'demo', projectId })).rejects.toThrow(
        'no space left on device',
      );
      expect(repository.list()).toEqual([]);
    });

    it('leaves nothing behind when the image is missing', async () => {
      engine.knownImages.clear();

      await expect(service.create({ name: 'demo', projectId })).rejects.toThrow(ImageNotFoundError);
      expect(repository.list()).toEqual([]);
    });

    it('creates no instance while Docker is down', async () => {
      engine.unavailable = true;

      await expect(service.create({ name: 'demo', projectId })).rejects.toThrow(
        DockerUnavailableError,
      );
      expect(repository.list()).toEqual([]);
    });
  });

  describe('list', () => {
    it('is empty to begin with', async () => {
      expect(await service.list()).toEqual([]);
    });

    it('takes the status from the Docker API, not from the database', async () => {
      await service.create({ name: 'first', projectId });
      await service.create({ name: 'second', projectId });
      engine.setState('container-2', 'exited');

      const byId = new Map((await service.list()).map((i) => [i.id, i.status]));

      expect(byId.get('id-1')).toBe('running');
      expect(byId.get('id-2')).toBe('exited');
    });

    it('reports an instance whose container vanished as missing', async () => {
      await service.create({ name: 'demo', projectId });
      engine.forget('container-1');

      expect((await service.list())[0]?.status).toBe(MISSING_STATUS);
    });

    it('ignores containers that are not claudops instances', async () => {
      engine.addUnmanagedContainer('some-other-container');

      expect(await service.list()).toEqual([]);
    });

    it('fails loudly when Docker is down instead of guessing a status', async () => {
      await service.create({ name: 'demo', projectId });
      engine.unavailable = true;

      await expect(service.list()).rejects.toThrow(DockerUnavailableError);
    });
  });

  describe('get', () => {
    it('returns a single instance with its live status', async () => {
      await service.create({ name: 'demo', projectId });
      engine.setState('container-1', 'exited');

      expect(await service.get('id-1')).toMatchObject({ id: 'id-1', status: 'exited' });
    });

    it('rejects an unknown id', async () => {
      await expect(service.get('nope')).rejects.toThrow(InstanceNotFoundError);
    });
  });

  describe('delete', () => {
    it('removes the container and the row', async () => {
      await service.create({ name: 'demo', projectId });

      await service.delete('id-1');

      expect(engine.containers.size).toBe(0);
      expect(repository.list()).toEqual([]);
    });

    it('still removes the row when the container is already gone', async () => {
      await service.create({ name: 'demo', projectId });
      engine.forget('container-1');

      await service.delete('id-1');

      expect(repository.list()).toEqual([]);
    });

    it('rejects an unknown id', async () => {
      await expect(service.delete('nope')).rejects.toThrow(InstanceNotFoundError);
    });

    it('keeps the row when the container removal fails, so it can be retried', async () => {
      await service.create({ name: 'demo', projectId });
      engine.unavailable = true;

      await expect(service.delete('id-1')).rejects.toThrow(DockerUnavailableError);

      engine.unavailable = false;
      expect(repository.get('id-1')).toBeDefined();
      await service.delete('id-1');
      expect(repository.list()).toEqual([]);
    });

    it('leaves other instances alone', async () => {
      await service.create({ name: 'first', projectId });
      await service.create({ name: 'second', projectId });

      await service.delete('id-1');

      expect((await service.list()).map((i) => i.id)).toEqual(['id-2']);
      expect(engine.containers.has('container-2')).toBe(true);
    });
  });

  describe('openTerminal', () => {
    it('attaches to the existing tmux session of the instance container', async () => {
      await service.create({ name: 'demo', projectId });

      const session = await service.openTerminal('id-1', { cols: 120, rows: 40 });

      expect(engine.lastTerminal().containerId).toBe('container-1');
      // `attach`, not `new`: the session belongs to the entrypoint.
      expect(engine.lastTerminal().options.command).toEqual([
        'tmux',
        '-u',
        'attach',
        '-t',
        'main',
      ]);
      expect(engine.lastTerminal().options.size).toEqual({ cols: 120, rows: 40 });
      expect(session.stream.writable).toBe(true);
    });

    it('arms the attach with a detach sequence, since Docker cannot kill an exec', async () => {
      await service.create({ name: 'demo', projectId });

      await service.openTerminal('id-1');

      // C-b d. Without it the tmux client outlives the browser and keeps
      // sizing the pane.
      expect(engine.lastTerminal().options.closeInput).toEqual(Uint8Array.from([0x02, 0x64]));
    });

    it('honours a project image with its own session name', async () => {
      const other = new InstanceService(repository, engine, {
        baseImage: 'claudops-base',
        instanceEnv,
        projects,
        tmuxSession: 'claude',
        generateId: () => 'id-9',
      });
      await other.create({ name: 'demo', projectId });

      await other.openTerminal('id-9');

      expect(engine.lastTerminal().options.command).toEqual([
      'tmux',
      '-u',
      'attach',
      '-t',
      'claude',
    ]);
    });

    it('attaches without a size when the client did not send one', async () => {
      await service.create({ name: 'demo', projectId });

      await service.openTerminal('id-1');

      expect(engine.lastTerminal().options.size).toBeUndefined();
    });

    it('rejects an unknown instance', async () => {
      await expect(service.openTerminal('nope')).rejects.toThrow(InstanceNotFoundError);
    });

    it('rejects an instance whose row has no container', async () => {
      repository.insert({
        id: 'id-orphan',
        name: 'half-created',
        image: 'claudops-base',
        projectId: null,
        repoUrl: null,
        repoBranch: null,
        createdAt: '2026-08-25T08:00:00.000Z',
      });

      await expect(service.openTerminal('id-orphan')).rejects.toThrow(ContainerMissingError);
    });

    it('passes a stopped container on as such', async () => {
      await service.create({ name: 'demo', projectId });
      engine.setState('container-1', 'exited');

      await expect(service.openTerminal('id-1')).rejects.toThrow(ContainerNotRunningError);
    });

    it('gives every connection its own session, so a reconnect is a new attach', async () => {
      await service.create({ name: 'demo', projectId });

      const first = await service.openTerminal('id-1');
      const second = await service.openTerminal('id-1');

      expect(second).not.toBe(first);
      expect(engine.terminals).toHaveLength(2);
    });
  });
});
