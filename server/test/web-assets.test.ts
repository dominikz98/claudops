/**
 * The SPA and the API share one port, so the thing worth testing is that they
 * do not shadow each other -- and that a server whose UI was never built still
 * serves the API.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrations.ts';
import { FakeDockerEngine } from './fake-engine.ts';

const INDEX = '<!doctype html><html><body><div id="app"></div></body></html>';

function appWith(webRoot: string | undefined): FastifyInstance {
  const db = new Database(':memory:');
  migrate(db);
  return buildApp({
    db,
    engine: new FakeDockerEngine(),
    baseImage: 'claudops-base',
    instanceEnv: {
      claudeOauthToken: undefined,
      gitUserName: undefined,
      gitUserEmail: undefined,
      firewallAllow: undefined,
    },
    webRoot,
    logLevel: 'silent',
  });
}

describe('static web assets', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'claudops-web-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  describe('with a built UI', () => {
    beforeEach(async () => {
      writeFileSync(join(directory, 'index.html'), INDEX);
      mkdirSync(join(directory, 'assets'));
      writeFileSync(join(directory, 'assets', 'main-abc123.js'), 'export {};\n');
      app = appWith(directory);
      await app.ready();
    });

    it('serves the SPA at the root', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('id="app"');
    });

    it('serves the hashed assets next to it', async () => {
      const response = await app.inject({ method: 'GET', url: '/assets/main-abc123.js' });

      expect(response.statusCode).toBe(200);
    });

    it('leaves the API alone', async () => {
      const response = await app.inject({ method: 'GET', url: '/instances' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ instances: unknown[] }>().instances).toEqual([]);
    });

    it('still answers an unknown path with the JSON 404', async () => {
      const response = await app.inject({ method: 'GET', url: '/nope' });

      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('not_found');
    });
  });

  describe('without a built UI', () => {
    it('serves the API anyway when the directory has no index.html', async () => {
      app = appWith(directory);
      await app.ready();

      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    });

    it('serves the API anyway when no web root is configured at all', async () => {
      app = appWith(undefined);
      await app.ready();

      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    });
  });
});
