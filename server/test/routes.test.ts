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
