/**
 * Issue #18 at the REST boundary: what a browser is allowed to see of an
 * instance's workspace, and what it is not.
 *
 * The path rules are covered as rules in `files.test.ts`; what is here is the
 * behaviour that only exists once the route, the service and an engine are
 * stacked -- the status codes, the headers the content response carries, and
 * that a refusal costs nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrations.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { createTestProject, testCipher } from './fixtures.ts';

/** The eight bytes every PNG starts with. Enough to be "not text". */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const REPORT = '# Run\n\nAll green.\n';

describe('browsing an instance workspace', () => {
  let app: FastifyInstance;
  let engine: FakeDockerEngine;
  let instanceId: string;

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
        firewallAllow: undefined,
      },
      cipher: testCipher(),
      // Small on purpose, for the same reason the upload limits are: the 413
      // has to be reachable without a ten-megabyte fixture.
      maxReadBytes: 1024,
      logLevel: 'silent',
      sendKeysPauseMs: 0,
    });
    await app.ready();

    const projectId = await createTestProject(app);
    const created = await app.inject({
      method: 'POST',
      url: '/instances',
      payload: { name: 'demo', projectId },
    });
    instanceId = created.json<{ id: string }>().id;

    engine.addFile('/workspace/repo/README.md', REPORT, new Date('2026-08-25T08:00:00.000Z'));
    engine.addFile('/workspace/repo/src/main.ts', 'export const x = 1;\n');
    engine.addFile('/workspace/.claudops/uploads/shot.png', PNG);
    engine.addFile('/workspace/heap.bin', new Uint8Array(2048));
  });

  afterEach(async () => {
    await app.close();
  });

  const list = (path?: string) =>
    app.inject({
      method: 'GET',
      url: `/instances/${instanceId}/files`,
      query: path === undefined ? {} : { path },
    });

  const content = (path: string, query: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: `/instances/${instanceId}/files/content`,
      query: { path, ...query },
    });

  describe('GET /instances/:id/files', () => {
    it('answers for the workspace root when no path is given', async () => {
      const response = await list();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ path: '/workspace', parent: null });
      expect(response.json<{ entries: { name: string }[] }>().entries.map((e) => e.name)).toEqual([
        '.claudops',
        'repo',
        'heap.bin',
      ]);
    });

    it('lists one directory with the paths the next request needs', async () => {
      const response = await list('/workspace/repo');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        path: '/workspace/repo',
        parent: '/workspace',
        truncated: false,
        entries: [
          { name: 'src', kind: 'directory', path: '/workspace/repo/src' },
          {
            name: 'README.md',
            kind: 'file',
            path: '/workspace/repo/README.md',
            size: REPORT.length,
            modifiedAt: '2026-08-25T08:00:00.000Z',
          },
        ],
      });
    });

    it('takes a path relative to the workspace', async () => {
      expect((await list('repo/src')).json()).toMatchObject({ path: '/workspace/repo/src' });
    });

    it('is a 404 about the path, not about the instance', async () => {
      const response = await list('/workspace/nope');

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: 'path_not_found' });
    });

    it('refuses a file with the code that names the other endpoint', async () => {
      const response = await list('/workspace/repo/README.md');

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'wrong_path_kind' });
    });

    it('still answers 404 for an instance that does not exist', async () => {
      expect((await app.inject({ method: 'GET', url: '/instances/nope/files' })).statusCode).toBe(
        404,
      );
    });
  });

  describe('a path outside the workspace', () => {
    it('is refused for both endpoints, without asking Docker', async () => {
      for (const path of ['../../etc/passwd', '/etc/passwd', '/workspace/../../root/.ssh/id_rsa']) {
        const listed = await list(path);
        expect(listed.statusCode, path).toBe(400);
        expect(listed.json(), path).toMatchObject({ error: 'path_outside_workspace' });

        const read = await content(path);
        expect(read.statusCode, path).toBe(400);
        expect(read.json(), path).toMatchObject({ error: 'path_outside_workspace' });
      }

      // The point of refusing in the server: nothing was run in the container
      // at all, so the refusal cannot depend on what is on the host.
      expect(engine.commands).toEqual([]);
    });
  });

  describe('GET /instances/:id/files/content', () => {
    it('hands text back as text/plain, whatever the file is called', async () => {
      const response = await content('/workspace/repo/README.md');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(response.body).toBe(REPORT);
    });

    it('hands a PNG back as an image, byte for byte', async () => {
      const response = await content('/workspace/.claudops/uploads/shot.png');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      // rawPayload, not body: a decoded PNG is not a PNG.
      expect(Uint8Array.from(response.rawPayload)).toEqual(PNG);
    });

    it('never lets what it serves execute on this origin', async () => {
      const response = await content('/workspace/repo/README.md');

      // The three together: the browser stays on the type the server chose,
      // the page has no origin to reach anything from, and nothing is cached
      // under a path the agent writes again.
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-disposition']).toContain('inline; filename="README.md"');
    });

    it('makes anything that is not text or an image a download', async () => {
      engine.addFile('/workspace/small.bin', PNG);
      const response = await content('/workspace/small.bin');

      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-disposition']).toContain('attachment');
    });

    it('turns a preview into a download when it is asked to', async () => {
      const response = await content('/workspace/repo/README.md', { download: '1' });

      // Still text -- only the disposition changes, so the same URL serves the
      // preview and the Save as.
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(response.headers['content-disposition']).toContain('attachment');
    });

    it('refuses a file over the limit without reading it', async () => {
      const response = await content('/workspace/heap.bin');

      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ error: 'file_too_large' });
      expect(response.json<{ message: string }>().message).toContain('2048');
    });

    it('refuses a directory rather than tarring it up', async () => {
      const response = await content('/workspace/repo');

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'wrong_path_kind' });
    });

    it('needs a path -- there is no default file', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/instances/${instanceId}/files/content`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_request' });
    });
  });

  describe('an instance whose container is not up', () => {
    it('answers 409 rather than an empty listing', async () => {
      const containerId = [...engine.containers.keys()][0] ?? '';
      engine.setState(containerId, 'exited');

      expect((await list()).statusCode).toBe(409);
      expect((await content('/workspace/repo/README.md')).json()).toMatchObject({
        error: 'container_not_running',
      });
    });
  });
});
