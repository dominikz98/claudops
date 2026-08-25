import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrations.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { createTestProject, TEST_REPO_URL, testCipher } from './fixtures.ts';

describe('instance REST API', () => {
  let app: FastifyInstance;
  let engine: FakeDockerEngine;
  /** The project instances are created from -- there is no other way in. */
  let projectId: string;

  beforeEach(async () => {
    const db = new Database(':memory:');
    migrate(db);
    engine = new FakeDockerEngine();
    app = buildApp({
      db,
      engine,
      baseImage: 'claudops-base',
      instanceEnv: {
        claudeOauthToken: 'oauth-token',
        gitUserName: undefined,
        gitUserEmail: undefined,
      },
      cipher: testCipher(),
      logLevel: 'silent',
    });
    await app.ready();
    projectId = await createTestProject(app, { repoBranch: 'main', gitToken: 'pat-secret' });
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/instances', payload });

  describe('POST /instances', () => {
    it('creates an instance and points at it', async () => {
      const response = await create({ name: 'demo', projectId });

      expect(response.statusCode).toBe(201);
      const body = response.json<{ id: string; status: string; containerId: string }>();
      expect(body).toMatchObject({ name: 'demo', status: 'running', projectId });
      expect(response.headers.location).toBe(`/instances/${body.id}`);
      expect(engine.containers.has(body.containerId)).toBe(true);
    });

    it('takes the repository from the project and never echoes its token', async () => {
      const response = await create({ name: 'demo', projectId });

      expect(response.statusCode).toBe(201);
      expect(response.body).not.toContain('pat-secret');
      expect(response.json<{ repoUrl: string; repoBranch: string }>()).toMatchObject({
        repoUrl: TEST_REPO_URL,
        repoBranch: 'main',
      });
    });

    it('rejects a request without a name or without a project', async () => {
      expect((await create({})).statusCode).toBe(400);
      expect((await create({ name: 'demo' })).statusCode).toBe(400);
      expect((await create({ projectId })).json<{ error: string }>().error).toBe('invalid_request');
    });

    it('rejects an unknown field instead of silently dropping it', async () => {
      const response = await create({ name: 'demo', env: { ANTHROPIC_API_KEY: 'nope' } });

      expect(response.statusCode).toBe(400);
    });

    it('rejects the repository fields that moved to the project', async () => {
      // A caller still on the old API has to hear about it rather than get an
      // instance pointed at the wrong repository.
      const response = await create({
        name: 'demo',
        projectId,
        repoUrl: 'https://github.com/someone/else.git',
        gitToken: 'pat-secret',
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an empty name', async () => {
      expect((await create({ name: '', projectId })).statusCode).toBe(400);
    });

    it('answers 422 for a project that does not exist', async () => {
      const response = await create({ name: 'demo', projectId: 'nope' });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: string }>().error).toBe('project_not_found');
    });

    it('answers 422 when the base image is not built', async () => {
      engine.knownImages.clear();

      const response = await create({ name: 'demo', projectId });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: string }>().error).toBe('image_not_found');
    });

    it('answers 503 while Docker is unreachable', async () => {
      engine.unavailable = true;

      const response = await create({ name: 'demo', projectId });

      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: string }>().error).toBe('docker_unavailable');
    });
  });

  describe('GET /instances', () => {
    it('starts empty', async () => {
      const response = await app.inject({ method: 'GET', url: '/instances' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ instances: unknown[] }>().instances).toEqual([]);
    });

    it('lists the status Docker reports', async () => {
      const first = (await create({ name: 'first', projectId })).json<{ containerId: string }>();
      await create({ name: 'second', projectId });
      engine.setState(first.containerId, 'exited');

      const instances = (await app.inject({ method: 'GET', url: '/instances' })).json<{
        instances: { name: string; status: string }[];
      }>().instances;

      expect(instances).toHaveLength(2);
      expect(instances.find((i) => i.name === 'first')?.status).toBe('exited');
      expect(instances.find((i) => i.name === 'second')?.status).toBe('running');
    });

    it('answers 503 rather than a stale status when Docker is gone', async () => {
      await create({ name: 'demo', projectId });
      engine.unavailable = true;

      const response = await app.inject({ method: 'GET', url: '/instances' });

      expect(response.statusCode).toBe(503);
    });
  });

  describe('GET /instances/:id', () => {
    it('returns one instance', async () => {
      const { id } = (await create({ name: 'demo', projectId })).json<{ id: string }>();

      const response = await app.inject({ method: 'GET', url: `/instances/${id}` });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(id);
    });

    it('answers 404 for an unknown id', async () => {
      const response = await app.inject({ method: 'GET', url: '/instances/nope' });

      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('not_found');
    });
  });

  describe('DELETE /instances/:id', () => {
    it('removes the container and the instance', async () => {
      const { id, containerId } = (await create({ name: 'demo', projectId })).json<{
        id: string;
        containerId: string;
      }>();

      const response = await app.inject({ method: 'DELETE', url: `/instances/${id}` });

      expect(response.statusCode).toBe(204);
      expect(engine.containers.has(containerId)).toBe(false);
      expect(
        (await app.inject({ method: 'GET', url: '/instances' })).json<{ instances: unknown[] }>()
          .instances,
      ).toEqual([]);
    });

    it('answers 404 for an unknown id', async () => {
      expect((await app.inject({ method: 'DELETE', url: '/instances/nope' })).statusCode).toBe(404);
    });

    it('answers 404 on a second delete', async () => {
      const { id } = (await create({ name: 'demo', projectId })).json<{ id: string }>();

      expect((await app.inject({ method: 'DELETE', url: `/instances/${id}` })).statusCode).toBe(204);
      expect((await app.inject({ method: 'DELETE', url: `/instances/${id}` })).statusCode).toBe(404);
    });
  });

  describe('POST /instances/:id/stop and /start', () => {
    const post = (id: string, action: string) =>
      app.inject({ method: 'POST', url: `/instances/${id}/${action}` });

    it('stops an instance and answers with its new status', async () => {
      const { id, containerId } = (await create({ name: 'demo', projectId })).json<{
        id: string;
        containerId: string;
      }>();

      const response = await post(id, 'stop');

      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string }>()).toMatchObject({ id, status: 'exited' });
      // Stopped, not removed -- that is the whole point of the endpoint.
      expect(engine.containers.has(containerId)).toBe(true);
    });

    it('starts it again', async () => {
      const { id } = (await create({ name: 'demo', projectId })).json<{ id: string }>();
      await post(id, 'stop');

      expect((await post(id, 'start')).json<{ status: string }>().status).toBe('running');
    });

    it('answers 404 for an unknown instance', async () => {
      expect((await post('nope', 'stop')).statusCode).toBe(404);
      expect((await post('nope', 'start')).statusCode).toBe(404);
    });

    it('answers 409 for an instance whose container is gone', async () => {
      const { id, containerId } = (await create({ name: 'demo', projectId })).json<{
        id: string;
        containerId: string;
      }>();
      engine.forget(containerId);

      const response = await post(id, 'start');

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe('container_missing');
    });
  });

  describe('GET /health', () => {
    it('is ok while Docker answers', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', docker: 'ok' });
    });

    it('is degraded when Docker does not', async () => {
      engine.unavailable = true;

      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);
      expect(response.json<{ status: string; docker: string }>()).toMatchObject({
        status: 'degraded',
        docker: 'unreachable',
      });
    });
  });

  it('answers 404 for an unknown route', async () => {
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
  });
});

/**
 * The startup reconcile, from the outside: the same database and the same
 * Docker host, a second server on top of them. That is what a restart of the
 * NUC's server is, and the leftovers below are what a killed one leaves.
 */
describe('a restart reconciles Docker against the database', () => {
  let db: Database.Database;
  let engine: FakeDockerEngine;
  let app: FastifyInstance;

  const boot = async (): Promise<FastifyInstance> => {
    const next = buildApp({
      db,
      engine,
      baseImage: 'claudops-base',
      instanceEnv: {
        claudeOauthToken: undefined,
        gitUserName: undefined,
        gitUserEmail: undefined,
      },
      cipher: testCipher(),
      logLevel: 'silent',
    });
    await next.ready();
    return next;
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    engine = new FakeDockerEngine();
    app = await boot();
  });

  afterEach(async () => {
    await app.close();
  });

  /** The reconcile is not awaited by `ready` -- the server must not wait for
   *  Docker to start listening -- so the assertions poll for its result. */
  const settled = async (done: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (done()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('the startup reconcile never got there');
  };

  it('ends in a consistent state after containers were removed and orphaned by hand', async () => {
    const projectId = await createTestProject(app);
    const { id, containerId } = (
      await app.inject({ method: 'POST', url: '/instances', payload: { name: 'demo', projectId } })
    ).json<{ id: string; containerId: string }>();

    // Two kinds of damage at once: the instance's container removed with
    // `docker rm`, and a labelled container left behind by a create that died
    // before its row was updated.
    engine.forget(containerId);
    engine.addOrphanContainer('container-orphan', 'id-never-recorded');
    engine.addVolume('claudops-id-never-recorded-workspace', 'id-never-recorded');
    engine.addVolume('someone-elses-data');

    await app.close();
    app = await boot();

    await settled(() => !engine.containers.has('container-orphan'));
    await settled(() => engine.volumes.size === 1);

    // The instance is still listed, and says what is true about it.
    const listed = (
      await app.inject({ method: 'GET', url: '/instances' })
    ).json<{ instances: { id: string; status: string; containerId: string | null }[] }>().instances;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, status: 'missing', containerId: null });
    // A volume that is nobody's business stays.
    expect([...engine.volumes.keys()]).toEqual(['someone-elses-data']);
  });

  it('leaves a healthy instance running across the restart', async () => {
    const projectId = await createTestProject(app);
    const { id, containerId } = (
      await app.inject({ method: 'POST', url: '/instances', payload: { name: 'demo', projectId } })
    ).json<{ id: string; containerId: string }>();

    await app.close();
    app = await boot();
    // Nothing to clean up, so nothing observable happens -- give the pass a
    // chance to run and then check it did not touch anything.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(engine.containers.has(containerId)).toBe(true);
    expect(
      (await app.inject({ method: 'GET', url: `/instances/${id}` })).json<{ status: string }>()
        .status,
    ).toBe('running');
  });

  it('starts anyway when Docker is unreachable', async () => {
    engine.unavailable = true;

    await app.close();
    app = await boot();

    // The reconcile is best effort; the server has to be usable without it.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(503);
    engine.unavailable = false;
    expect((await app.inject({ method: 'GET', url: '/instances' })).statusCode).toBe(200);
  });
});
