import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DEFAULT_INSTANCE_LIMITS, type InstanceEnvConfig } from '../src/config.ts';
import { InstanceRepository } from '../src/db/instances.ts';
import { ActivityTracker } from '../src/instances/activity.ts';
import { migrate } from '../src/db/migrations.ts';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  DockerUnavailableError,
  ImageNotFoundError,
} from '../src/docker/engine.ts';
import {
  ContainerCommandFailedError,
  ContainerMissingError,
  INSTANCE_EFFORTS,
  INSTANCE_MODELS,
  InstanceNotFoundError,
  InstanceService,
  InvalidUploadNameError,
  MISSING_STATUS,
  SessionNotReadyError,
  UnknownChoiceError,
  UPLOAD_DIR,
  uploadFileName,
  UploadTooLargeError,
} from '../src/instances/service.ts';
import { ProjectRepository } from '../src/db/projects.ts';
import { projectImageTag } from '../src/docker/labels.ts';
import {
  ProjectImageNotReadyError,
  ProjectNotFoundError,
  ProjectService,
  type CreateProjectInput,
} from '../src/projects/service.ts';
import { SecretUndecryptableError } from '../src/secrets/cipher.ts';
import { createStatusTokens } from '../src/status/tokens.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { TEST_REPO_URL, testCipher } from './fixtures.ts';

/**
 * The activity fallback reads the tmux pane on a view whose instance has not
 * reported anything yet, so `engine.commands` is no longer empty just because
 * nothing was done to the container. A capture-pane changes nothing in there,
 * which is what a test asking "was anything done to it" means.
 */
const changesSomething = (entry: { command: string[] }): boolean =>
  !entry.command.includes('capture-pane');

const instanceEnv: InstanceEnvConfig = {
  claudeOauthToken: 'oauth-token',
  gitUserName: 'claudops',
  gitUserEmail: 'claudops@example.invalid',
  firewallAllow: undefined,
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
  /** A project whose image is built. Instances start from that image, so
   *  everything below would be blocked by a project still on `pending`. */
  const addProject = (input: Partial<CreateProjectInput> = {}): string => {
    projectCount += 1;
    const id = projects.create({
      name: `project-${String(projectCount)}`,
      repoUrl: TEST_REPO_URL,
      ...input,
    }).id;

    projectRepository.setImageState(id, 'ready', '', '2026-08-25T07:00:00.000Z');
    engine.knownImages.add(projectImageTag(id));
    return id;
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
      instanceEnv,
      projects,
      generateId: () => ids.shift() ?? 'exhausted',
      now: () => new Date('2026-08-25T08:00:00.000Z'),
      // The pause exists for a real TUI reading real keystrokes; here it would
      // only make the suite slower.
      sendKeysPauseMs: 0,
    });
    projectId = addProject({ name: 'demo-project' });
  });

  describe('create', () => {
    it('starts a labelled container and records the instance', async () => {
      const instance = await service.create({ name: 'demo', projectId });

      expect(instance).toMatchObject({
        id: 'id-1',
        name: 'demo',
        // The project's image, not the base one: that is where its environment
        // lives.
        image: projectImageTag(projectId),
        containerId: 'container-1',
        projectId,
        status: 'running',
        createdAt: '2026-08-25T08:00:00.000Z',
      });
      expect(engine.specFor('id-1')).toMatchObject({
        name: 'claudops-id-1',
        image: projectImageTag(projectId),
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

    it('caps the container at the default two cores and four gigabytes', async () => {
      await service.create({ name: 'demo', projectId });

      expect(engine.specFor('id-1')?.limits).toEqual(DEFAULT_INSTANCE_LIMITS);
    });

    it('honours configured limits, so the NUC can be sized by its operator', async () => {
      const small = new InstanceService(repository, engine, {
        instanceEnv,
        projects,
        limits: { cpus: 1, memoryBytes: 512 * 1024 * 1024 },
        generateId: () => 'id-small',
      });

      await small.create({ name: 'demo', projectId });

      expect(engine.specFor('id-small')?.limits).toEqual({
        cpus: 1,
        memoryBytes: 512 * 1024 * 1024,
      });
    });

    it('grants NET_ADMIN, so the container can install its own egress firewall', async () => {
      await service.create({ name: 'demo', projectId });

      expect(engine.specFor('id-1')?.capAdd).toEqual(['NET_ADMIN']);
    });

    it('adds nothing else, so Docker keeps the default set it needs', async () => {
      await service.create({ name: 'demo', projectId });

      // NET_RAW is deliberately absent: the legacy iptables backend needs it,
      // but it is already in Docker's default set, and adding it here would
      // suggest the default set is being replaced rather than extended.
      expect(engine.specFor('id-1')?.capAdd).not.toContain('NET_RAW');
    });

    it('hands the operator whitelist over as FIREWALL_ALLOW', async () => {
      const wide = new InstanceService(repository, engine, {
        instanceEnv: { ...instanceEnv, firewallAllow: 'api.nuget.org, 10.9.8.0/24' },
        projects,
        generateId: () => 'id-wide',
      });

      await wide.create({ name: 'demo', projectId });

      expect(engine.specFor('id-wide')?.env).toMatchObject({
        FIREWALL_ALLOW: 'api.nuget.org, 10.9.8.0/24',
      });
    });

    it('never sets an ANTHROPIC_API_KEY next to the OAuth token', async () => {
      await service.create({ name: 'demo', projectId });

      expect(Object.keys(engine.specFor('id-1')?.env ?? {})).not.toContain('ANTHROPIC_API_KEY');
    });

    it('omits variables that were not configured', async () => {
      const bare = new InstanceService(repository, engine, {
        instanceEnv: {
          claudeOauthToken: undefined,
          gitUserName: undefined,
          gitUserEmail: undefined,
          firewallAllow: undefined,
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
      // The project says `ready` but Docker no longer has the tag -- somebody
      // ran `docker rmi`. Docker is still the truth about what exists.
      engine.knownImages.clear();

      await expect(service.create({ name: 'demo', projectId })).rejects.toThrow(ImageNotFoundError);
      expect(repository.list()).toEqual([]);
    });

    it('refuses a project whose image is not built yet', async () => {
      const id = addProject({ name: 'still-building' });
      projectRepository.setImageState(id, 'building', null);

      await expect(service.create({ name: 'demo', projectId: id })).rejects.toThrow(
        ProjectImageNotReadyError,
      );
      // Nothing was written and nothing was started: the check comes before
      // both.
      expect(repository.list()).toEqual([]);
      expect(engine.containers.size).toBe(0);
    });

    it('refuses a project whose image failed to build', async () => {
      const id = addProject({ name: 'broken' });
      projectRepository.setImageState(id, 'failed', 'Step 3/3 : RUN false');

      await expect(service.create({ name: 'demo', projectId: id })).rejects.toThrow(
        /failed to build/,
      );
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

  /** `running` and "the console can be attached" are minutes apart: the
   *  entrypoint installs a firewall and clones a repository first. What tells
   *  them apart is the container's own healthcheck, not a timer here. */
  describe('session readiness', () => {
    it('tells a container that is up from a session that is ready', async () => {
      await service.create({ name: 'demo', projectId });
      engine.setHealth('container-1', 'starting');

      expect(await service.get('id-1')).toMatchObject({
        status: 'running',
        session: 'starting',
      });

      engine.setHealth('container-1', 'healthy');

      expect(await service.get('id-1')).toMatchObject({
        status: 'running',
        session: 'ready',
      });
    });

    it('reports a container that never reached its session as failed', async () => {
      // What the healthcheck's retries turn a hanging entrypoint into: a
      // terminal answer, rather than `starting` for as long as it runs.
      await service.create({ name: 'demo', projectId });
      engine.setHealth('container-1', 'unhealthy');

      expect(await service.get('id-1')).toMatchObject({
        status: 'running',
        session: 'failed',
      });
    });

    it('has no session to report for a container that is not running', async () => {
      await service.create({ name: 'demo', projectId });
      engine.setState('container-1', 'exited');

      expect(await service.get('id-1')).toMatchObject({ status: 'exited', session: 'none' });

      engine.forget('container-1');

      expect(await service.get('id-1')).toMatchObject({ status: MISSING_STATUS, session: 'none' });
    });

    it('treats an image without a healthcheck as ready rather than locking it out', async () => {
      // An instance from an image built before the healthcheck existed reports
      // nothing. Reading that as `starting` would disable its console forever.
      await service.create({ name: 'demo', projectId });
      engine.setHealth('container-1', undefined);

      expect(await service.get('id-1')).toMatchObject({ session: 'ready' });
    });

    it('answers a fresh create with `starting`, without asking Docker', async () => {
      // The container was started microseconds ago, so no healthcheck has run.
      // Saying anything else would hand the caller a console it cannot open.
      const instance = await service.create({ name: 'demo', projectId });

      expect(instance).toMatchObject({ status: 'running', session: 'starting' });
    });

    it('carries the readiness through the list as well as through get', async () => {
      await service.create({ name: 'first', projectId });
      await service.create({ name: 'second', projectId });
      engine.setHealth('container-2', 'starting');

      const byId = new Map((await service.list()).map((i) => [i.id, i.session]));

      expect(byId.get('id-1')).toBe('ready');
      expect(byId.get('id-2')).toBe('starting');
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

    it('takes the volumes of the instance with it', async () => {
      await service.create({ name: 'demo', projectId });
      // A volume the container removal does not reach: `-v` only takes the
      // anonymous ones hanging off that container.
      engine.addVolume('claudops-id-1-workspace', 'id-1');

      await service.delete('id-1');

      expect(engine.volumes.size).toBe(0);
    });

    it('removes the volumes even when the container is already gone', async () => {
      await service.create({ name: 'demo', projectId });
      engine.addVolume('claudops-id-1-workspace', 'id-1');
      engine.forget('container-1');

      await service.delete('id-1');

      expect(engine.volumes.size).toBe(0);
    });

    it('leaves the volumes of other instances and of strangers alone', async () => {
      await service.create({ name: 'first', projectId });
      await service.create({ name: 'second', projectId });
      engine.addVolume('claudops-id-1-workspace', 'id-1');
      engine.addVolume('claudops-id-2-workspace', 'id-2');
      engine.addVolume('someone-elses-data');

      await service.delete('id-1');

      expect([...engine.volumes.keys()]).toEqual(['claudops-id-2-workspace', 'someone-elses-data']);
    });
  });

  describe('stop and start', () => {
    it('stops the container and reports what Docker says afterwards', async () => {
      await service.create({ name: 'demo', projectId });

      expect(await service.stop('id-1')).toMatchObject({ id: 'id-1', status: 'exited' });
      // The container survives the stop -- that is the difference to a delete.
      expect(engine.containers.has('container-1')).toBe(true);
      expect(repository.get('id-1')?.containerId).toBe('container-1');
    });

    it('starts a stopped instance again', async () => {
      await service.create({ name: 'demo', projectId });
      await service.stop('id-1');

      expect(await service.start('id-1')).toMatchObject({ status: 'running' });
    });

    it('is idempotent in both directions, like the Docker API', async () => {
      await service.create({ name: 'demo', projectId });

      await service.stop('id-1');
      expect(await service.stop('id-1')).toMatchObject({ status: 'exited' });
      await service.start('id-1');
      expect(await service.start('id-1')).toMatchObject({ status: 'running' });
    });

    it('rejects an unknown instance and one without a container', async () => {
      await expect(service.stop('nope')).rejects.toThrow(InstanceNotFoundError);

      repository.insert({
        id: 'id-orphan',
        name: 'half-created',
        image: 'claudops-project-gone',
        projectId: null,
        repoUrl: null,
        repoBranch: null,
        model: null,
        effort: null,
        createdAt: '2026-08-25T08:00:00.000Z',
      });

      await expect(service.start('id-orphan')).rejects.toThrow(ContainerMissingError);
    });

    it('passes a container Docker no longer has on as such', async () => {
      await service.create({ name: 'demo', projectId });
      engine.forget('container-1');

      await expect(service.stop('id-1')).rejects.toThrow(ContainerNotFoundError);
    });
  });

  describe('reconcile', () => {
    it('has nothing to do on a healthy state', async () => {
      await service.create({ name: 'demo', projectId });

      expect(await service.reconcile()).toEqual({
        removedContainers: [],
        removedVolumes: [],
        endedInstances: [],
        failures: [],
      });
      expect(engine.containers.has('container-1')).toBe(true);
      expect(repository.get('id-1')?.containerId).toBe('container-1');
    });

    it('removes a labelled container no instance points at', async () => {
      // What a server killed between runContainer and attachContainer leaves.
      engine.addOrphanContainer('container-orphan', 'id-gone');

      const report = await service.reconcile();

      expect(report.removedContainers).toEqual(['container-orphan']);
      expect(engine.containers.has('container-orphan')).toBe(false);
    });

    it('removes a container whose instance points at a different one', async () => {
      await service.create({ name: 'demo', projectId });
      // A create that was rolled back and run again: same instance label, a
      // container the row no longer knows about.
      engine.addOrphanContainer('container-stale', 'id-1');

      const report = await service.reconcile();

      expect(report.removedContainers).toEqual(['container-stale']);
      expect(engine.containers.has('container-1')).toBe(true);
    });

    it('leaves containers that are not claudops alone', async () => {
      engine.addUnmanagedContainer('some-other-container');

      expect((await service.reconcile()).removedContainers).toEqual([]);
      expect(engine.containers.has('some-other-container')).toBe(true);
    });

    it('ends an instance whose container is gone instead of deleting its row', async () => {
      await service.create({ name: 'demo', projectId });
      engine.forget('container-1');

      const report = await service.reconcile();

      expect(report.endedInstances).toEqual(['id-1']);
      // The row survives: it is somebody's instance, and only Docker's half of
      // it went away.
      expect(repository.get('id-1')?.containerId).toBeNull();
      expect((await service.list())[0]?.status).toBe(MISSING_STATUS);
    });

    it('says nothing about an instance that has already been told', async () => {
      await service.create({ name: 'demo', projectId });
      engine.forget('container-1');

      await service.reconcile();

      expect((await service.reconcile()).endedInstances).toEqual([]);
    });

    it('removes the volumes of instances that no longer exist', async () => {
      await service.create({ name: 'demo', projectId });
      engine.addVolume('claudops-id-1-workspace', 'id-1');
      engine.addVolume('claudops-id-gone-workspace', 'id-gone');
      engine.addVolume('someone-elses-data');

      const report = await service.reconcile();

      expect(report.removedVolumes).toEqual(['claudops-id-gone-workspace']);
      expect([...engine.volumes.keys()]).toEqual([
        'claudops-id-1-workspace',
        'someone-elses-data',
      ]);
    });

    it('keeps the volume of an instance whose container is gone', async () => {
      await service.create({ name: 'demo', projectId });
      engine.addVolume('claudops-id-1-workspace', 'id-1');
      engine.forget('container-1');

      // The instance is still there, so its workspace is not a leftover -- its
      // delete is what removes both.
      expect((await service.reconcile()).removedVolumes).toEqual([]);
      expect(engine.volumes.has('claudops-id-1-workspace')).toBe(true);
    });

    it('carries on past a removal that fails and reports it', async () => {
      engine.addVolume('claudops-id-gone-workspace', 'id-gone');
      engine.addVolume('claudops-id-also-gone-workspace', 'id-also-gone');
      engine.failVolumeRemoval.add('claudops-id-gone-workspace');

      const report = await service.reconcile();

      expect(report.removedVolumes).toEqual(['claudops-id-also-gone-workspace']);
      expect(report.failures).toEqual([
        {
          resource: 'volume claudops-id-gone-workspace',
          message: 'volume is in use - claudops-id-gone-workspace',
        },
      ]);
    });

    it('fails loudly while Docker is down rather than reporting a clean host', async () => {
      engine.unavailable = true;

      await expect(service.reconcile()).rejects.toThrow(DockerUnavailableError);
    });
  });

  describe('model and effort', () => {
    /** Only the tmux typing, without the two file writes in front of it -- what
     *  a test about "did the switch reach the session" wants to read. */
    const sentLines = (): string[] =>
      engine.commands
        .filter((entry) => entry.command[1] === 'send-keys')
        .map((entry) => entry.command.at(-1) ?? '');

    it('starts the container with the chosen model and effort', async () => {
      const instance = await service.create({
        name: 'demo',
        projectId,
        model: 'haiku',
        effort: 'low',
      });

      expect(instance).toMatchObject({ model: 'haiku', effort: 'low' });
      expect(engine.specFor('id-1')?.env).toMatchObject({
        CLAUDE_MODEL: 'haiku',
        CLAUDE_EFFORT: 'low',
      });
      expect(repository.get('id-1')).toMatchObject({ model: 'haiku', effort: 'low' });
    });

    it('passes neither variable when nothing was chosen', async () => {
      await service.create({ name: 'demo', projectId });

      const env = engine.specFor('id-1')?.env ?? {};
      expect(Object.keys(env)).not.toContain('CLAUDE_MODEL');
      expect(Object.keys(env)).not.toContain('CLAUDE_EFFORT');
    });

    it('refuses an unknown value without leaving a row or a container behind', async () => {
      await expect(service.create({ name: 'demo', projectId, model: 'gpt-4' })).rejects.toThrow(
        UnknownChoiceError,
      );

      expect(await service.list()).toEqual([]);
      expect(engine.containers.size).toBe(0);
    });

    it('writes the override files and types the change into the session', async () => {
      await service.create({ name: 'demo', projectId, model: 'haiku', effort: 'low' });
      engine.commands.length = 0;

      const instance = await service.setModelEffort('id-1', { model: 'opus', effort: 'xhigh' });

      expect(instance).toMatchObject({ model: 'opus', effort: 'xhigh' });
      // The override files first: they are what the next container start reads,
      // and they carry the values as arguments rather than inside the script.
      expect(engine.commands[0]?.command.slice(-2)).toEqual(['opus', 'xhigh']);
      // `/model` before `/effort` -- which levels exist depends on the model.
      expect(sentLines()).toEqual(['/model opus', 'Enter', '/effort xhigh', 'Enter']);
      expect(repository.get('id-1')).toMatchObject({ model: 'opus', effort: 'xhigh' });
    });

    it('leaves the stored value alone for a field that is not sent', async () => {
      await service.create({ name: 'demo', projectId, model: 'haiku', effort: 'low' });
      engine.commands.length = 0;

      expect(await service.setModelEffort('id-1', { effort: 'high' })).toMatchObject({
        model: 'haiku',
        effort: 'high',
      });
      // Only the effort was typed: a `/model haiku` on an instance already on
      // haiku would cost a full prompt-cache rebuild for nothing.
      expect(sentLines()).toEqual(['/effort high', 'Enter']);
    });

    it('types nothing at all when nothing changes', async () => {
      await service.create({ name: 'demo', projectId, model: 'haiku' });
      engine.commands.length = 0;

      await service.setModelEffort('id-1', { model: 'haiku' });

      expect(engine.commands.filter(changesSomething)).toEqual([]);
    });

    it('resets the effort with /effort auto and the model with the file alone', async () => {
      await service.create({ name: 'demo', projectId, model: 'haiku', effort: 'low' });
      engine.commands.length = 0;

      await service.setModelEffort('id-1', { model: null, effort: null });

      // An empty override file, not a removed one: a missing file falls back to
      // the environment, which still says haiku.
      expect(engine.commands[0]?.command.slice(-2)).toEqual(['', '']);
      // `/effort` has `auto` for this; `/model` has nothing, so the model
      // reaches the running session not at all and the next start through the
      // file. The UI offers a reset on neither.
      expect(sentLines()).toEqual(['/effort auto', 'Enter']);
      expect(repository.get('id-1')).toMatchObject({ model: null, effort: null });
    });

    it('refuses an unknown value and leaves the instance as it was', async () => {
      await service.create({ name: 'demo', projectId, model: 'haiku' });
      engine.commands.length = 0;

      await expect(service.setModelEffort('id-1', { model: 'gpt-4' })).rejects.toThrow(
        UnknownChoiceError,
      );

      expect(engine.commands).toEqual([]);
      expect(repository.get('id-1')?.model).toBe('haiku');
    });

    it('refuses an unknown instance, one without a container and one that is not up', async () => {
      await expect(service.setModelEffort('nope', { model: 'opus' })).rejects.toThrow(
        InstanceNotFoundError,
      );

      repository.insert({
        id: 'id-orphan',
        name: 'half-created',
        image: 'claudops-project-gone',
        projectId: null,
        repoUrl: null,
        repoBranch: null,
        model: null,
        effort: null,
        createdAt: '2026-08-25T08:00:00.000Z',
      });
      await expect(service.setModelEffort('id-orphan', { model: 'opus' })).rejects.toThrow(
        ContainerMissingError,
      );

      await service.create({ name: 'demo', projectId });
      engine.setHealth('container-1', 'starting');
      await expect(service.setModelEffort('id-1', { model: 'opus' })).rejects.toThrow(
        SessionNotReadyError,
      );
      // Nothing was written anywhere: half a switch is worse than none.
      expect(engine.commands).toEqual([]);
      expect(repository.get('id-1')?.model).toBeNull();
    });

    it('stops at a command the container refused, before the row is written', async () => {
      await service.create({ name: 'demo', projectId, model: 'haiku' });
      engine.commands.length = 0;
      // What `tmux send-keys` says when the pane it was given is not there --
      // an exec that ran and failed, not one that could not start. A function,
      // because the fake answers per command since #15.
      engine.commandResult = () => ({ exitCode: 1, output: "can't find pane: main:0.0" });

      await expect(service.setModelEffort('id-1', { model: 'opus' })).rejects.toThrow(
        ContainerCommandFailedError,
      );

      // The first command is the one that failed, and nothing followed it.
      expect(engine.commands).toHaveLength(1);
      expect(repository.get('id-1')?.model).toBe('haiku');
    });

    it('keeps the database out of it when the container is not running', async () => {
      await service.create({ name: 'demo', projectId, model: 'haiku' });
      engine.setState('container-1', 'exited');

      await expect(service.setModelEffort('id-1', { model: 'opus' })).rejects.toThrow(
        SessionNotReadyError,
      );
      expect(repository.get('id-1')?.model).toBe('haiku');
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
        image: 'claudops-project-gone',
        projectId: null,
        repoUrl: null,
        repoBranch: null,
        model: null,
        effort: null,
        createdAt: '2026-08-25T08:00:00.000Z',
      });

      await expect(service.openTerminal('id-orphan')).rejects.toThrow(ContainerMissingError);
    });

    it('refuses while the session is still starting, before it execs anything', async () => {
      // `tmux attach` against a session that does not exist exits non-zero, and
      // by then the socket is open and the only thing left to report is a
      // failed session. So the readiness is asked first.
      await service.create({ name: 'demo', projectId });
      engine.setHealth('container-1', 'starting');

      await expect(service.openTerminal('id-1')).rejects.toThrow(SessionNotReadyError);
      expect(engine.terminals).toEqual([]);
    });

    it('refuses a container whose session never came up', async () => {
      await service.create({ name: 'demo', projectId });
      engine.setHealth('container-1', 'unhealthy');

      await expect(service.openTerminal('id-1')).rejects.toMatchObject({
        name: 'SessionNotReadyError',
        readiness: 'failed',
      });
    });

    it('passes a stopped container on as such', async () => {
      // Deliberately not a SessionNotReadyError: "not running" says more, and
      // Start is the way out of it.
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

  describe('upload', () => {
    /** The file bytes of an archive, which start behind its 512-byte header. */
    const contentOf = (archive: Uint8Array, length: number): string =>
      new TextDecoder().decode(archive.slice(512, 512 + length));

    const upload = async (name: string, text = 'screenshot') =>
      await service.upload('id-1', { name, content: new TextEncoder().encode(text) });

    beforeEach(async () => {
      await service.create({ name: 'demo', projectId });
    });

    it('puts the file into the uploads directory and answers with its path', async () => {
      const result = await upload('shot.png');

      expect(result).toEqual({
        name: 'shot.png',
        path: `${UPLOAD_DIR}/shot.png`,
        size: 10,
        announced: true,
      });
      expect(engine.archives).toHaveLength(1);
      expect(engine.lastArchive()).toMatchObject({
        containerId: 'container-1',
        targetDir: UPLOAD_DIR,
      });
      expect(contentOf(engine.lastArchive().archive, 10)).toBe('screenshot');
    });

    it('creates the directory before writing into it', async () => {
      await upload('shot.png');

      // Docker's extraction does not create the parent of an entry, so the
      // reading of the current usage doubles as the mkdir.
      const script = engine.commands[0]?.command.join(' ') ?? '';
      expect(script).toContain(`mkdir -p ${UPLOAD_DIR}`);
      expect(script).toContain('-type f');
    });

    it('types the path into the tmux session without submitting it', async () => {
      const result = await upload('shot.png');

      expect(engine.tmuxCommands()).toEqual([
        ['tmux', 'send-keys', '-t', 'main', '-l', `${result.path} `],
      ]);
    });

    it('lands outside the clone, so it cannot become a commit', () => {
      // The clone is /workspace/<repo>; this is its sibling, not its child.
      expect(UPLOAD_DIR.startsWith('/workspace/')).toBe(true);
      expect(UPLOAD_DIR).toBe('/workspace/.claudops/uploads');
    });

    it('uploads but does not announce while the session is still starting', async () => {
      engine.setHealth('container-1', 'starting');

      const result = await upload('shot.png');

      expect(result.announced).toBe(false);
      expect(engine.archives).toHaveLength(1);
      expect(engine.tmuxCommands()).toEqual([]);
    });

    it('reports a tmux that refused rather than failing the upload', async () => {
      engine.commandResult = (command) =>
        command[0] === 'tmux'
          ? { exitCode: 1, output: "can't find session" }
          : { exitCode: 0, output: '' };

      const result = await upload('shot.png');

      expect(result.announced).toBe(false);
      expect(engine.archives).toHaveLength(1);
    });

    it('refuses a file over the per-file limit without asking Docker', async () => {
      service = new InstanceService(repository, engine, {
        instanceEnv,
        projects,
        uploads: { maxFileBytes: 4, maxInstanceBytes: 1024 },
      });

      await expect(upload('shot.png', 'far too much')).rejects.toBeInstanceOf(UploadTooLargeError);
      expect(engine.archives).toEqual([]);
      expect(engine.commands).toEqual([]);
    });

    it('refuses a file the instance no longer has room for', async () => {
      service = new InstanceService(repository, engine, {
        instanceEnv,
        projects,
        uploads: { maxFileBytes: 1024, maxInstanceBytes: 1024 },
      });
      // What find reports for the files already lying there.
      engine.commandResult = () => ({ exitCode: 0, output: '1000\n20\n' });

      const error = await upload('shot.png').catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(UploadTooLargeError);
      expect((error as UploadTooLargeError).scope).toBe('instance');
      expect(engine.archives).toEqual([]);
    });

    it('counts what is already there against the limit', async () => {
      engine.uploadUsage = 40;
      service = new InstanceService(repository, engine, {
        instanceEnv,
        projects,
        uploads: { maxFileBytes: 1024, maxInstanceBytes: 45 },
      });

      // 40 + 5 fits, 40 + 6 does not.
      await expect(upload('a.txt', '12345')).resolves.toMatchObject({ size: 5 });
      await expect(upload('b.txt', '123456')).rejects.toBeInstanceOf(UploadTooLargeError);
    });

    it('refuses a name that would escape the uploads directory', async () => {
      await expect(upload('../../etc/passwd')).resolves.toMatchObject({
        // Only the last segment survives, and it is not a traversal any more.
        path: `${UPLOAD_DIR}/passwd`,
      });
      await expect(upload('..')).rejects.toBeInstanceOf(InvalidUploadNameError);
    });

    it('refuses a stopped container and an unknown instance', async () => {
      await expect(service.upload('nope', { name: 'a.txt', content: new Uint8Array(1) })).rejects
        .toBeInstanceOf(InstanceNotFoundError);

      await service.stop('id-1');
      await expect(upload('a.txt')).rejects.toBeInstanceOf(ContainerNotRunningError);
    });

    it('says so when the uploads directory is not usable', async () => {
      engine.commandResult = () => ({ exitCode: 1, output: 'Permission denied' });

      await expect(upload('a.txt')).rejects.toThrow('Permission denied');
      expect(engine.archives).toEqual([]);
    });
  });

  describe('uploadFileName', () => {
    it('keeps a plain name and takes only the last path segment', () => {
      expect(uploadFileName('report.pdf')).toBe('report.pdf');
      expect(uploadFileName('C:\\Users\\me\\shot.png')).toBe('shot.png');
      expect(uploadFileName('/tmp/a/b/log.txt')).toBe('log.txt');
    });

    it('replaces everything a shell or a console would read as syntax', () => {
      expect(uploadFileName('my file; rm -rf $HOME.txt')).toBe('my_file__rm_-rf__HOME.txt');
      expect(uploadFileName('Bericht Öl.pdf')).toBe('Bericht__l.pdf');
    });

    it('refuses a name that is nothing but dots', () => {
      expect(() => uploadFileName('..')).toThrow(InvalidUploadNameError);
      expect(() => uploadFileName('/')).toThrow(InvalidUploadNameError);
      expect(() => uploadFileName('')).toThrow(InvalidUploadNameError);
    });

    it('unhides a dotfile rather than letting an upload hide itself', () => {
      expect(uploadFileName('.env')).toBe('env');
    });

    it('shortens a long name from the front, keeping the extension', () => {
      const name = uploadFileName(`${'a'.repeat(200)}.png`);

      expect(name).toHaveLength(80);
      expect(name.endsWith('.png')).toBe(true);
    });
  });

  /**
   * The third axis. What the tracker itself decides is tested in
   * activity.test.ts; this is about the join -- that a view carries it, that
   * Docker outranks it, and that a container is created able to report at all.
   */
  describe('activity', () => {
    /** The tracker the status listener would write into, shared with a service
     *  built on the same repository and engine. */
    let activity: ActivityTracker;
    let reporting: InstanceService;

    /** The pane probe is deliberately not awaited by the view, so a test that
     *  wants its answer has to let the microtask and timer queues run. */
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
      activity = new ActivityTracker();
      reporting = new InstanceService(repository, engine, {
        instanceEnv,
        projects,
        generateId: () => ids.shift() ?? 'exhausted',
        now: () => new Date('2026-08-25T08:00:00.000Z'),
        sendKeysPauseMs: 0,
        activity,
        statusTokens: createStatusTokens('a-shared-secret-long-enough'),
        statusPort: 8081,
      });
    });

    it('starts out idle, because nothing has been asked of it yet', async () => {
      const instance = await reporting.create({ name: 'demo', projectId });

      expect(instance.activity).toBe('idle');
      expect(await reporting.get('id-1')).toMatchObject({ activity: 'idle' });
    });

    it('reports what the instance last said about itself', async () => {
      await reporting.create({ name: 'demo', projectId });

      activity.record('id-1', { event: 'UserPromptSubmit' });
      expect(await reporting.get('id-1')).toMatchObject({ activity: 'running' });

      activity.record('id-1', { event: 'Notification', notificationType: 'permission_prompt' });
      expect((await reporting.list())[0]).toMatchObject({ activity: 'needs_input' });

      activity.record('id-1', { event: 'Stop' });
      expect((await reporting.list())[0]).toMatchObject({ activity: 'done' });
    });

    /**
     * The ticket's fourth criterion. A container that died takes its Claude
     * with it, so the `running` it last reported would otherwise stand forever
     * -- there is no process left to send the Stop that would clear it.
     */
    it('stops reporting an activity once the container is not running', async () => {
      await reporting.create({ name: 'demo', projectId });
      activity.record('id-1', { event: 'UserPromptSubmit' });

      await reporting.stop('id-1');

      expect(await reporting.get('id-1')).toMatchObject({ status: 'exited', activity: 'none' });
    });

    it('says the same about a container Docker no longer has', async () => {
      await reporting.create({ name: 'demo', projectId });
      activity.record('id-1', { event: 'UserPromptSubmit' });

      engine.forget('container-1');

      expect(await reporting.get('id-1')).toMatchObject({
        status: MISSING_STATUS,
        activity: 'none',
      });
    });

    it('asks the pane when the hooks have said nothing', async () => {
      await reporting.create({ name: 'demo', projectId });
      engine.commandResult = () => ({
        exitCode: 0,
        output: '✳ Building… (esc to interrupt)',
      });

      await reporting.get('id-1');
      await settle();

      expect(engine.commands.at(-1)?.command).toEqual([
        'tmux',
        'capture-pane',
        '-p',
        '-t',
        'main',
      ]);
      expect(await reporting.get('id-1')).toMatchObject({ activity: 'running' });
    });

    it('keeps answering when the probe fails, because it is a fallback', async () => {
      await reporting.create({ name: 'demo', projectId });
      engine.failNextCommand = new Error('container is gone');

      expect(await reporting.get('id-1')).toMatchObject({ activity: 'idle' });
      await settle();
      expect(await reporting.get('id-1')).toMatchObject({ activity: 'idle' });
    });

    it('forgets everything about a deleted instance', async () => {
      await reporting.create({ name: 'demo', projectId });
      activity.record('id-1', { event: 'UserPromptSubmit' });

      await reporting.delete('id-1');

      expect(activity.activityOf('id-1')).toBeUndefined();
    });

    it('hands the container what it needs to report, and no more', async () => {
      await reporting.create({ name: 'demo', projectId });

      const env = engine.specFor('id-1')?.env ?? {};
      expect(env).toMatchObject({
        CLAUDOPS_INSTANCE_ID: 'id-1',
        CLAUDOPS_STATUS_PORT: '8081',
        CLAUDOPS_STATUS_TOKEN: createStatusTokens('a-shared-secret-long-enough').issue('id-1'),
      });
      // The URL is not in here: the address is the gateway of the bridge this
      // container ends up on, which only the container can see.
      expect(env).not.toHaveProperty('CLAUDOPS_STATUS_URL');
    });

    it('gives a container no token at all when there is no endpoint to report to', async () => {
      // `service`, not `reporting`: built without the two status options, which
      // is every instance created before this existed.
      await service.create({ name: 'demo', projectId });

      const env = engine.specFor('id-1')?.env ?? {};
      expect(env).not.toHaveProperty('CLAUDOPS_STATUS_TOKEN');
      expect(env).not.toHaveProperty('CLAUDOPS_STATUS_PORT');
    });
  });

});

/**
 * The web client mirrors these two lists rather than fetching them -- nine
 * strings, and the server's schema is what enforces them. Read out of the file
 * rather than imported: `web/` is a separate package with its own tsconfig, and
 * a test that reaches into it with an import would not survive either build.
 *
 * What this catches is the one failure mode of a mirrored list: a model added
 * on one side only, which shows up as a dropdown entry the server answers 400
 * to.
 */
describe('the web client mirrors the model and effort lists', () => {
  const api = readFileSync(join(import.meta.dirname, '../../web/src/api.ts'), 'utf8');

  const listIn = (name: string): string[] => {
    const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(api);
    expect(match, `${name} is not declared in web/src/api.ts`).not.toBeNull();
    return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? '');
  };

  it('offers exactly the models the server accepts', () => {
    expect(listIn('INSTANCE_MODELS')).toEqual([...INSTANCE_MODELS]);
  });

  it('offers exactly the effort levels the server accepts', () => {
    expect(listIn('INSTANCE_EFFORTS')).toEqual([...INSTANCE_EFFORTS]);
  });
});
