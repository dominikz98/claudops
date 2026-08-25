import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrations.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { createTestProject, TEST_REPO_URL, testCipher } from './fixtures.ts';

const PAT = 'ghp_pat-secret';

interface ProjectBody {
  id: string;
  name: string;
  repoUrl: string;
  repoBranch: string | null;
  buildingBlocks: { dotnet: boolean; playwright: boolean };
  hasGitToken: boolean;
  instanceCount: number;
  createdAt: string;
  updatedAt: string;
}

describe('project REST API', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let engine: FakeDockerEngine;

  /** Every project row as text -- what a `grep` over the database file would
   *  see. */
  const storedRows = (): string => JSON.stringify(db.prepare('SELECT * FROM projects').all());

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/projects', payload });

  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/projects/${id}`, payload });

  const addInstance = (name: string, projectId: string) =>
    app.inject({ method: 'POST', url: '/instances', payload: { name, projectId } });

  const list = async (): Promise<ProjectBody[]> =>
    (await app.inject({ method: 'GET', url: '/projects' })).json<{ projects: ProjectBody[] }>()
      .projects;

  beforeEach(async () => {
    db = new Database(':memory:');
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
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /projects', () => {
    it('creates a project and points at it', async () => {
      const response = await post({ name: 'claudops', repoUrl: TEST_REPO_URL });

      expect(response.statusCode).toBe(201);
      const body = response.json<ProjectBody>();
      expect(body).toMatchObject({
        name: 'claudops',
        repoUrl: TEST_REPO_URL,
        repoBranch: null,
        buildingBlocks: { dotnet: false, playwright: false },
        hasGitToken: false,
        instanceCount: 0,
      });
      expect(response.headers.location).toBe(`/projects/${body.id}`);
    });

    it('keeps the building blocks it was given', async () => {
      const response = await post({
        name: 'dotnet-app',
        repoUrl: TEST_REPO_URL,
        repoBranch: 'develop',
        buildingBlocks: { dotnet: true, playwright: true },
      });

      expect(response.json<ProjectBody>()).toMatchObject({
        repoBranch: 'develop',
        buildingBlocks: { dotnet: true, playwright: true },
      });
    });

    it('reports a stored PAT without ever returning it', async () => {
      const response = await post({ name: 'private', repoUrl: TEST_REPO_URL, gitToken: PAT });

      expect(response.statusCode).toBe(201);
      expect(response.body).not.toContain(PAT);
      expect(response.json<ProjectBody>().hasGitToken).toBe(true);
    });

    it('stores the PAT encrypted, so the database holds no readable token', async () => {
      await post({ name: 'private', repoUrl: TEST_REPO_URL, gitToken: PAT });

      expect(storedRows()).not.toContain(PAT);
      expect(storedRows()).toContain('v1:');
    });

    it('rejects a project without a name or without a repository', async () => {
      expect((await post({ name: 'x' })).statusCode).toBe(400);
      expect((await post({ repoUrl: TEST_REPO_URL })).statusCode).toBe(400);
      expect((await post({ name: '', repoUrl: TEST_REPO_URL })).statusCode).toBe(400);
    });

    it('rejects an unknown field and an unknown building block', async () => {
      expect((await post({ name: 'x', repoUrl: TEST_REPO_URL, env: {} })).statusCode).toBe(400);
      expect(
        (await post({ name: 'x', repoUrl: TEST_REPO_URL, buildingBlocks: { rust: true } }))
          .statusCode,
      ).toBe(400);
    });

    it('answers 409 for a name that is already taken', async () => {
      await post({ name: 'claudops', repoUrl: TEST_REPO_URL });

      const response = await post({ name: 'claudops', repoUrl: 'https://host/other.git' });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe('project_name_taken');
    });
  });

  describe('without CLAUDOPS_SECRET_KEY', () => {
    let keyless: FastifyInstance;

    beforeEach(async () => {
      const other = new Database(':memory:');
      migrate(other);
      keyless = buildApp({
        db: other,
        engine,
        baseImage: 'claudops-base',
        instanceEnv: {
          claudeOauthToken: undefined,
          gitUserName: undefined,
          gitUserEmail: undefined,
        },
        logLevel: 'silent',
      });
      await keyless.ready();
    });

    afterEach(async () => {
      await keyless.close();
    });

    it('refuses to store a PAT rather than keeping it in the clear', async () => {
      const response = await keyless.inject({
        method: 'POST',
        url: '/projects',
        payload: { name: 'private', repoUrl: TEST_REPO_URL, gitToken: PAT },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: string }>().error).toBe('secret_key_missing');
      expect(response.body).not.toContain(PAT);
    });

    it('still creates a project that needs no PAT', async () => {
      const response = await keyless.inject({
        method: 'POST',
        url: '/projects',
        payload: { name: 'public', repoUrl: TEST_REPO_URL },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  describe('GET /projects', () => {
    it('starts empty', async () => {
      expect(await list()).toEqual([]);
    });

    it('lists by name and counts the instances of each project', async () => {
      const zulu = await createTestProject(app, { name: 'zulu' });
      const alpha = await createTestProject(app, { name: 'alpha' });
      await addInstance('i1', zulu);
      await addInstance('i2', zulu);

      const projects = await list();

      expect(projects.map((project) => project.name)).toEqual(['alpha', 'zulu']);
      expect(projects.find((project) => project.id === zulu)?.instanceCount).toBe(2);
      expect(projects.find((project) => project.id === alpha)?.instanceCount).toBe(0);
    });
  });

  describe('GET /projects/:id', () => {
    it('returns one project', async () => {
      const id = await createTestProject(app, { gitToken: PAT });

      const response = await app.inject({ method: 'GET', url: `/projects/${id}` });

      expect(response.statusCode).toBe(200);
      expect(response.json<ProjectBody>()).toMatchObject({ id, hasGitToken: true });
      expect(response.body).not.toContain(PAT);
    });

    it('answers 404 for an unknown id', async () => {
      const response = await app.inject({ method: 'GET', url: '/projects/nope' });

      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('not_found');
    });
  });

  describe('PATCH /projects/:id', () => {
    let id: string;

    beforeEach(async () => {
      id = await createTestProject(app, { name: 'before', repoBranch: 'main', gitToken: PAT });
    });

    it('changes what it was given and leaves the rest alone', async () => {
      const response = await patch(id, { name: 'after', repoBranch: 'develop' });

      expect(response.statusCode).toBe(200);
      expect(response.json<ProjectBody>()).toMatchObject({
        name: 'after',
        repoBranch: 'develop',
        repoUrl: TEST_REPO_URL,
        hasGitToken: true,
      });
    });

    it('keeps the PAT when the field is not sent -- the empty form field case', async () => {
      await patch(id, { name: 'renamed' });

      expect((await patch(id, { repoBranch: 'other' })).json<ProjectBody>().hasGitToken).toBe(true);
    });

    it('replaces the PAT with a new one, and neither is readable', async () => {
      await patch(id, { gitToken: 'ghp_second-secret' });

      expect(storedRows()).not.toContain('ghp_second-secret');
      expect(storedRows()).not.toContain(PAT);
      expect(
        (await app.inject({ method: 'GET', url: `/projects/${id}` })).json<ProjectBody>()
          .hasGitToken,
      ).toBe(true);
    });

    it('removes the PAT when handed null', async () => {
      const response = await patch(id, { gitToken: null });

      expect(response.json<ProjectBody>().hasGitToken).toBe(false);
      expect(storedRows()).not.toContain('v1:');
    });

    it('changes one building block without clearing the other', async () => {
      await patch(id, { buildingBlocks: { dotnet: true, playwright: true } });

      const response = await patch(id, { buildingBlocks: { playwright: false } });

      expect(response.json<ProjectBody>().buildingBlocks).toEqual({
        dotnet: true,
        playwright: false,
      });
    });

    it('moves updatedAt forward and leaves createdAt where it was', async () => {
      const before = (
        await app.inject({ method: 'GET', url: `/projects/${id}` })
      ).json<ProjectBody>();

      const after = (await patch(id, { name: 'touched' })).json<ProjectBody>();

      expect(after.createdAt).toBe(before.createdAt);
      expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
    });

    it('rejects an empty patch and an unknown field', async () => {
      expect((await patch(id, {})).statusCode).toBe(400);
      expect((await patch(id, { nope: 1 })).statusCode).toBe(400);
    });

    it('answers 404 for an unknown id and 409 for a name that is taken', async () => {
      expect((await patch('nope', { name: 'x' })).statusCode).toBe(404);

      await createTestProject(app, { name: 'taken' });
      const response = await patch(id, { name: 'taken' });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe('project_name_taken');
    });
  });

  describe('DELETE /projects/:id', () => {
    it('removes a project nothing points at', async () => {
      const id = await createTestProject(app);

      expect((await app.inject({ method: 'DELETE', url: `/projects/${id}` })).statusCode).toBe(204);
      expect(await list()).toEqual([]);
    });

    it('answers 404 for an unknown id and on a second delete', async () => {
      const id = await createTestProject(app);

      expect((await app.inject({ method: 'DELETE', url: '/projects/nope' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/projects/${id}` })).statusCode).toBe(204);
      expect((await app.inject({ method: 'DELETE', url: `/projects/${id}` })).statusCode).toBe(404);
    });

    it('refuses while an instance still points at it, and says how many', async () => {
      const id = await createTestProject(app);
      const instance = (await addInstance('i1', id)).json<{ id: string }>();

      const refused = await app.inject({ method: 'DELETE', url: `/projects/${id}` });

      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ error: string }>().error).toBe('project_in_use');
      expect(refused.json<{ message: string }>().message).toContain('1');

      // Once the instance is gone the project can go too.
      await app.inject({ method: 'DELETE', url: `/instances/${instance.id}` });
      expect((await app.inject({ method: 'DELETE', url: `/projects/${id}` })).statusCode).toBe(204);
    });

    it('refuses even when the container of that instance has already exited', async () => {
      const id = await createTestProject(app);
      const instance = (await addInstance('i1', id)).json<{ containerId: string }>();
      engine.setState(instance.containerId, 'exited');

      expect((await app.inject({ method: 'DELETE', url: `/projects/${id}` })).statusCode).toBe(409);
    });
  });
});
