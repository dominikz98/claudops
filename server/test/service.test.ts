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
import { FakeDockerEngine } from './fake-engine.ts';

const instanceEnv: InstanceEnvConfig = {
  claudeOauthToken: 'oauth-token',
  gitUserName: 'claudops',
  gitUserEmail: 'claudops@example.invalid',
};

describe('InstanceService', () => {
  let repository: InstanceRepository;
  let engine: FakeDockerEngine;
  let service: InstanceService;
  let ids: string[];

  beforeEach(() => {
    const db = new Database(':memory:');
    migrate(db);
    repository = new InstanceRepository(db);
    engine = new FakeDockerEngine();
    ids = ['id-1', 'id-2', 'id-3'];
    service = new InstanceService(repository, engine, {
      baseImage: 'claudops-base',
      instanceEnv,
      generateId: () => ids.shift() ?? 'exhausted',
      now: () => new Date('2026-08-25T08:00:00.000Z'),
    });
  });

  describe('create', () => {
    it('starts a labelled container and records the instance', async () => {
      const instance = await service.create({ name: 'demo' });

      expect(instance).toMatchObject({
        id: 'id-1',
        name: 'demo',
        image: 'claudops-base',
        containerId: 'container-1',
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

    it('passes repo and token into the container environment', async () => {
      await service.create({
        name: 'demo',
        repoUrl: 'https://github.com/dominikz98/claudops.git',
        repoBranch: 'feature/dz/3',
        gitToken: 'pat-secret',
      });

      expect(engine.specFor('id-1')?.env).toEqual({
        REPO_URL: 'https://github.com/dominikz98/claudops.git',
        REPO_BRANCH: 'feature/dz/3',
        GIT_TOKEN: 'pat-secret',
        GIT_USER_NAME: 'claudops',
        GIT_USER_EMAIL: 'claudops@example.invalid',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      });
    });

    it('never sets an ANTHROPIC_API_KEY next to the OAuth token', async () => {
      await service.create({ name: 'demo' });

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
        generateId: () => 'id-bare',
      });

      await bare.create({ name: 'demo' });

      expect(engine.specFor('id-bare')?.env).toEqual({});
    });

    it('keeps no token in the returned instance or the database', async () => {
      const instance = await service.create({ name: 'demo', gitToken: 'pat-secret' });

      expect(JSON.stringify(instance)).not.toContain('pat-secret');
      expect(JSON.stringify(repository.get('id-1'))).not.toContain('pat-secret');
    });

    it('rolls the row back when the container cannot be started', async () => {
      engine.failNextRun = new Error('no space left on device');

      await expect(service.create({ name: 'demo' })).rejects.toThrow('no space left on device');
      expect(repository.list()).toEqual([]);
    });

    it('leaves nothing behind when the image is missing', async () => {
      engine.knownImages.clear();

      await expect(service.create({ name: 'demo' })).rejects.toThrow(ImageNotFoundError);
      expect(repository.list()).toEqual([]);
    });

    it('creates no instance while Docker is down', async () => {
      engine.unavailable = true;

      await expect(service.create({ name: 'demo' })).rejects.toThrow(DockerUnavailableError);
      expect(repository.list()).toEqual([]);
    });
  });

  describe('list', () => {
    it('is empty to begin with', async () => {
      expect(await service.list()).toEqual([]);
    });

    it('takes the status from the Docker API, not from the database', async () => {
      await service.create({ name: 'first' });
      await service.create({ name: 'second' });
      engine.setState('container-2', 'exited');

      const byId = new Map((await service.list()).map((i) => [i.id, i.status]));

      expect(byId.get('id-1')).toBe('running');
      expect(byId.get('id-2')).toBe('exited');
    });

    it('reports an instance whose container vanished as missing', async () => {
      await service.create({ name: 'demo' });
      engine.forget('container-1');

      expect((await service.list())[0]?.status).toBe(MISSING_STATUS);
    });

    it('ignores containers that are not claudops instances', async () => {
      engine.addUnmanagedContainer('some-other-container');

      expect(await service.list()).toEqual([]);
    });

    it('fails loudly when Docker is down instead of guessing a status', async () => {
      await service.create({ name: 'demo' });
      engine.unavailable = true;

      await expect(service.list()).rejects.toThrow(DockerUnavailableError);
    });
  });

  describe('get', () => {
    it('returns a single instance with its live status', async () => {
      await service.create({ name: 'demo' });
      engine.setState('container-1', 'exited');

      expect(await service.get('id-1')).toMatchObject({ id: 'id-1', status: 'exited' });
    });

    it('rejects an unknown id', async () => {
      await expect(service.get('nope')).rejects.toThrow(InstanceNotFoundError);
    });
  });

  describe('delete', () => {
    it('removes the container and the row', async () => {
      await service.create({ name: 'demo' });

      await service.delete('id-1');

      expect(engine.containers.size).toBe(0);
      expect(repository.list()).toEqual([]);
    });

    it('still removes the row when the container is already gone', async () => {
      await service.create({ name: 'demo' });
      engine.forget('container-1');

      await service.delete('id-1');

      expect(repository.list()).toEqual([]);
    });

    it('rejects an unknown id', async () => {
      await expect(service.delete('nope')).rejects.toThrow(InstanceNotFoundError);
    });

    it('keeps the row when the container removal fails, so it can be retried', async () => {
      await service.create({ name: 'demo' });
      engine.unavailable = true;

      await expect(service.delete('id-1')).rejects.toThrow(DockerUnavailableError);

      engine.unavailable = false;
      expect(repository.get('id-1')).toBeDefined();
      await service.delete('id-1');
      expect(repository.list()).toEqual([]);
    });

    it('leaves other instances alone', async () => {
      await service.create({ name: 'first' });
      await service.create({ name: 'second' });

      await service.delete('id-1');

      expect((await service.list()).map((i) => i.id)).toEqual(['id-2']);
      expect(engine.containers.has('container-2')).toBe(true);
    });
  });

  describe('openTerminal', () => {
    it('attaches to the existing tmux session of the instance container', async () => {
      await service.create({ name: 'demo' });

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
      await service.create({ name: 'demo' });

      await service.openTerminal('id-1');

      // C-b d. Without it the tmux client outlives the browser and keeps
      // sizing the pane.
      expect(engine.lastTerminal().options.closeInput).toEqual(Uint8Array.from([0x02, 0x64]));
    });

    it('honours a project image with its own session name', async () => {
      const other = new InstanceService(repository, engine, {
        baseImage: 'claudops-base',
        instanceEnv,
        tmuxSession: 'claude',
        generateId: () => 'id-9',
      });
      await other.create({ name: 'demo' });

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
      await service.create({ name: 'demo' });

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
        repoUrl: null,
        repoBranch: null,
        createdAt: '2026-08-25T08:00:00.000Z',
      });

      await expect(service.openTerminal('id-orphan')).rejects.toThrow(ContainerMissingError);
    });

    it('passes a stopped container on as such', async () => {
      await service.create({ name: 'demo' });
      engine.setState('container-1', 'exited');

      await expect(service.openTerminal('id-1')).rejects.toThrow(ContainerNotRunningError);
    });

    it('gives every connection its own session, so a reconnect is a new attach', async () => {
      await service.create({ name: 'demo' });

      const first = await service.openTerminal('id-1');
      const second = await service.openTerminal('id-1');

      expect(second).not.toBe(first);
      expect(engine.terminals).toHaveLength(2);
    });
  });
});
