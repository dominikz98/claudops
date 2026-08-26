import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrations.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { createTestProject, TEST_REPO_URL, testCipher, waitForImage } from './fixtures.ts';

const PAT = 'ghp_pat-secret';

interface ProjectBody {
  id: string;
  name: string;
  repoUrl: string;
  repoBranch: string | null;
  buildingBlocks: { dotnet: boolean; playwright: boolean };
  image: { tag: string; status: string; builtAt: string | null };
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
        firewallAllow: undefined,
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
          firewallAllow: undefined,
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
  describe('the project image', () => {
    const buildLog = async (id: string) =>
      (await app.inject({ method: 'GET', url: `/projects/${id}/build-log` })).json<{
        status: string;
        builtAt: string | null;
        log: string;
      }>();

    const build = (id: string) => app.inject({ method: 'POST', url: `/projects/${id}/build` });

    it('answers the create with an image that is not built yet', async () => {
      const body = (await post({ name: 'fresh', repoUrl: TEST_REPO_URL })).json<ProjectBody>();

      // The build takes minutes for a real environment, so the answer is the
      // state to watch rather than the finished image.
      expect(body.image).toMatchObject({ tag: `claudops-project-${body.id}`, status: 'pending' });
      expect(body.image.builtAt).toBeNull();
    });

    it('builds it right after the create', async () => {
      const id = await createTestProject(app, { buildingBlocks: { dotnet: true } });

      const project = (await app.inject({ method: 'GET', url: `/projects/${id}` }))
        .json<ProjectBody>();
      expect(project.image.status).toBe('ready');
      expect(project.image.builtAt).not.toBeNull();
      expect(engine.builds).toHaveLength(1);
      expect(engine.builds[0]).toMatchObject({
        tag: `claudops-project-${id}`,
        buildArgs: { WITH_DOTNET: '1', WITH_PLAYWRIGHT: '0', BASE_IMAGE: 'claudops-base' },
      });
    });

    it('hands out the build log on its own endpoint', async () => {
      const id = await createTestProject(app);

      const log = await buildLog(id);

      expect(log.status).toBe('ready');
      expect(log.log).toContain('FROM claudops-base');
      // Not in the project itself: a log runs to tens of kilobytes and the list
      // asks for every project at once.
      expect(JSON.stringify(await list())).not.toContain('FROM claudops-base');
    });

    it('rebuilds when the building blocks change', async () => {
      const id = await createTestProject(app);

      const response = await patch(id, { buildingBlocks: { playwright: true } });
      expect(response.json<ProjectBody>().image.status).toBe('pending');

      await waitForImage(app, id);
      expect(engine.builds).toHaveLength(2);
      expect(engine.builds[1]?.buildArgs).toMatchObject({ WITH_PLAYWRIGHT: '1' });
    });

    it('does not rebuild when the same blocks are sent again', async () => {
      const id = await createTestProject(app, { buildingBlocks: { dotnet: true } });

      // What the UI does on every save: it posts the whole form back.
      const response = await patch(id, { buildingBlocks: { dotnet: true, playwright: false } });

      expect(response.json<ProjectBody>().image.status).toBe('ready');
      expect(engine.builds).toHaveLength(1);
    });

    it('does not rebuild for a rename or a new token', async () => {
      const id = await createTestProject(app);

      await patch(id, { name: 'renamed' });
      await patch(id, { gitToken: PAT });

      expect(engine.builds).toHaveLength(1);
      // The tag follows the id, so a rename leaves the image where it is.
      const project = (await app.inject({ method: 'GET', url: `/projects/${id}` }))
        .json<ProjectBody>();
      expect(project.image).toMatchObject({ tag: `claudops-project-${id}`, status: 'ready' });
    });

    it('takes an explicit rebuild and answers 202', async () => {
      const id = await createTestProject(app);

      const response = await build(id);

      expect(response.statusCode).toBe(202);
      expect(response.json<ProjectBody>().image.status).toBe('pending');
      await waitForImage(app, id);
      expect(engine.builds).toHaveLength(2);
    });

    it('records a failed build and blocks instance creation with it', async () => {
      engine.failNextBuild = new Error('pull access denied for claudops-base');
      const created = (await post({ name: 'broken', repoUrl: TEST_REPO_URL }))
        .json<ProjectBody>();

      await waitForImage(app, created.id, 'failed');

      const log = await buildLog(created.id);
      expect(log.status).toBe('failed');
      expect(log.log).toContain('pull access denied');

      const refused = await addInstance('i1', created.id);
      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ error: string }>().error).toBe('project_image_not_ready');
      expect(refused.json<{ status: string }>().status).toBe('failed');
    });

    it('is the way out of a failed build', async () => {
      engine.failNextBuild = new Error('no space left on device');
      const created = (await post({ name: 'retry-me', repoUrl: TEST_REPO_URL }))
        .json<ProjectBody>();
      await waitForImage(app, created.id, 'failed');

      await build(created.id);
      await waitForImage(app, created.id);

      expect((await addInstance('i1', created.id)).statusCode).toBe(201);
    });

    it('refuses an instance while the image is still building', async () => {
      // A real dotnet build occupies this state for minutes; here it is 50 ms.
      engine.buildDelayMs = 50;
      const created = (await post({ name: 'slow', repoUrl: TEST_REPO_URL }))
        .json<ProjectBody>();

      const refused = await addInstance('i1', created.id);

      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ error: string }>().error).toBe('project_image_not_ready');
      expect(refused.json<{ status: string }>().status).toBe('building');

      // Let the build finish, so it does not run into the app being closed.
      engine.buildDelayMs = 0;
      await waitForImage(app, created.id);
    });

    it('removes the image when the project is deleted', async () => {
      const id = await createTestProject(app);

      await app.inject({ method: 'DELETE', url: `/projects/${id}` });

      expect(engine.removedImages).toEqual([`claudops-project-${id}`]);
    });

    it('deletes the project even when the image cannot be removed', async () => {
      const id = await createTestProject(app);
      engine.unavailable = true;

      // The row is already gone at that point; a leftover tag must not turn a
      // successful delete into a 500.
      expect((await app.inject({ method: 'DELETE', url: `/projects/${id}` })).statusCode).toBe(204);
    });

    it('answers 404 for the build and the log of an unknown project', async () => {
      expect((await build('nope')).statusCode).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: '/projects/nope/build-log' })).statusCode,
      ).toBe(404);
    });
  });
});
