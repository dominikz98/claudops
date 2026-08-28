import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrations.ts';
import { ProjectRepository } from '../src/db/projects.ts';
import { projectImageTag } from '../src/docker/labels.ts';
import {
  defaultProjectContext,
  ProjectImageBuilder,
  type ImageBuildLogger,
} from '../src/projects/images.ts';
import { ProjectService } from '../src/projects/service.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { TEST_REPO_URL, testCipher } from './fixtures.ts';

/** The builder logs through Fastify's logger in production; here it goes
 *  nowhere, but the calls still have to typecheck. */
const silent: ImageBuildLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('ProjectImageBuilder', () => {
  let repository: ProjectRepository;
  let projects: ProjectService;
  let engine: FakeDockerEngine;
  let builder: ProjectImageBuilder;

  const addProject = (name: string, blocks = {}): string =>
    projects.create({ name, repoUrl: TEST_REPO_URL, buildingBlocks: blocks }).id;

  const imageOf = (id: string) => repository.get(id)?.image;

  beforeEach(() => {
    const db = new Database(':memory:');
    migrate(db);
    repository = new ProjectRepository(db);
    projects = new ProjectService(repository, { cipher: testCipher() });
    engine = new FakeDockerEngine();
    builder = new ProjectImageBuilder(projects, repository, engine, {
      contextDir: '/build/context',
      baseImage: 'claudops-base',
      dotnetChannel: '10.0',
      logger: silent,
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });
  });

  describe('build', () => {
    it('tags the image after the project and records when it was built', async () => {
      const id = addProject('demo');

      await builder.build(id);

      expect(imageOf(id)).toMatchObject({
        status: 'ready',
        builtAt: '2026-08-25T09:00:00.000Z',
      });
      expect(engine.builds).toHaveLength(1);
      expect(engine.builds[0]).toMatchObject({
        tag: projectImageTag(id),
        contextDir: '/build/context',
        dockerfile: 'Dockerfile',
        labels: { 'claudops.project': id },
      });
    });

    it('turns the building blocks into build args', async () => {
      const id = addProject('with-both', { dotnet: true, playwright: true });

      await builder.build(id);

      expect(engine.builds[0]?.buildArgs).toEqual({
        BASE_IMAGE: 'claudops-base',
        WITH_DOTNET: '1',
        WITH_PLAYWRIGHT: '1',
        DOTNET_CHANNEL: '10.0',
      });
    });

    it('passes a block that is off as 0 rather than leaving it out', async () => {
      // The template compares against "1"; a missing arg would take the default
      // in the Dockerfile instead, which is not the same guarantee.
      const id = addProject('dotnet-only', { dotnet: true });

      await builder.build(id);

      expect(engine.builds[0]?.buildArgs).toMatchObject({
        WITH_DOTNET: '1',
        WITH_PLAYWRIGHT: '0',
      });
    });

    it('keeps the daemon output as the build log', async () => {
      engine.buildOutput = ['Step 1/3 : FROM claudops-base\n', 'Step 2/3 : RUN true\n'];
      const id = addProject('logged');

      await builder.build(id);

      expect(imageOf(id)?.log).toBe('Step 1/3 : FROM claudops-base\nStep 2/3 : RUN true\n');
    });

    it('writes the log away while the build is still running', async () => {
      // The point of the whole exercise: `GET /projects/:id/build-log` reads
      // the same column, so a five-minute build is readable while it runs
      // instead of staying empty until it ends.
      engine.buildOutput = ['Step 1/3 : FROM claudops-base\n'];
      engine.buildDelayMs = 20;
      const id = addProject('slow');

      // Not awaited: the fake emits its output before it stalls, which is the
      // state a reader finds mid-build.
      const running = builder.build(id);

      expect(imageOf(id)).toMatchObject({
        status: 'building',
        log: 'Step 1/3 : FROM claudops-base\n',
      });

      await running;
      expect(imageOf(id)?.status).toBe('ready');
    });

    it('throttles those writes instead of rewriting the log per line', async () => {
      // A real build emits a line per apt package, and every write rewrites the
      // whole accumulated log. `now` stands still here, so nothing but the
      // first chunk falls outside the flush window.
      const writes = vi.spyOn(repository, 'setImageState');
      engine.buildOutput = ['a\n', 'b\n', 'c\n', 'd\n'];
      const id = addProject('chatty');

      await builder.build(id);

      // The `building` marker at the start, and the first chunk. The three
      // after it are inside the window.
      expect(writes.mock.calls.filter((call) => call[1] === 'building')).toHaveLength(2);
      expect(imageOf(id)?.log).toBe('a\nb\nc\nd\n');
    });

    it('writes again once the flush window has passed', async () => {
      let clock = Date.parse('2026-08-25T09:00:00.000Z');
      const ticking = new ProjectImageBuilder(projects, repository, engine, {
        contextDir: '/build/context',
        baseImage: 'claudops-base',
        dotnetChannel: '10.0',
        logger: silent,
        logFlushMs: 1000,
        // Two seconds per call, so every chunk is outside the window.
        now: () => new Date((clock += 2000)),
      });
      const writes = vi.spyOn(repository, 'setImageState');
      engine.buildOutput = ['a\n', 'b\n', 'c\n'];
      const id = addProject('long');

      await ticking.build(id);

      expect(writes.mock.calls.filter((call) => call[1] === 'building')).toHaveLength(4);
    });

    it('records a failure with its output and the reason', async () => {
      engine.buildOutput = ['Step 3/3 : RUN dotnet --version\n'];
      engine.failNextBuild = new Error('executor failed: exit code 127');
      const id = addProject('broken');

      await builder.build(id);

      const image = imageOf(id);
      expect(image?.status).toBe('failed');
      // Both halves matter: the last step says where, the error says why.
      expect(image?.log).toContain('Step 3/3 : RUN dotnet --version');
      expect(image?.log).toContain('exit code 127');
    });

    it('leaves the date of the last working image on a failed rebuild', async () => {
      const id = addProject('was-fine');
      await builder.build(id);

      engine.failNextBuild = new Error('no space left on device');
      await builder.build(id);

      expect(imageOf(id)).toMatchObject({
        status: 'failed',
        // Still there: an instance started before this rebuild is running on
        // that image, and when it was made is the useful part.
        builtAt: '2026-08-25T09:00:00.000Z',
      });
    });

    it('never throws -- a failed build is a state, not an error of the caller', async () => {
      const id = addProject('unreachable');
      engine.unavailable = true;

      await expect(builder.build(id)).resolves.toBeUndefined();
      expect(imageOf(id)?.status).toBe('failed');
    });

    it('does nothing for a project that was deleted while it waited', async () => {
      const id = addProject('gone');
      repository.delete(id);

      await builder.build(id);

      expect(engine.builds).toEqual([]);
    });

    it('truncates a log that would otherwise fill the database', async () => {
      const small = new ProjectImageBuilder(projects, repository, engine, {
        contextDir: '/build/context',
        baseImage: 'claudops-base',
        dotnetChannel: '10.0',
        logger: silent,
        maxLogBytes: 64,
      });
      engine.buildOutput = ['a'.repeat(500), 'the-tail-is-what-matters\n'];
      const id = addProject('noisy');

      await small.build(id);

      const log = imageOf(id)?.log ?? '';
      expect(log).toContain('the-tail-is-what-matters');
      expect(log).toContain('bytes cut');
      // The cap is on the kept output; the note about what was dropped is on
      // top of it.
      expect(log.length).toBeLessThan(200);
    });
  });

  describe('request', () => {
    it('queues one build per project, not one per call', async () => {
      const id = addProject('demo');

      builder.request(id);
      builder.request(id);
      builder.request(id);
      await builder.settled();

      expect(engine.builds).toHaveLength(1);
    });

    it('runs queued builds one after another', async () => {
      const first = addProject('one');
      const second = addProject('two');

      builder.request(first);
      builder.request(second);
      await builder.settled();

      expect(engine.builds.map((build) => build.tag)).toEqual([
        projectImageTag(first),
        projectImageTag(second),
      ]);
      expect(imageOf(first)?.status).toBe('ready');
      expect(imageOf(second)?.status).toBe('ready');
    });

    it('takes the same project again once its build has finished', async () => {
      const id = addProject('demo');

      builder.request(id);
      await builder.settled();
      builder.request(id);
      await builder.settled();

      expect(engine.builds).toHaveLength(2);
    });
  });

  describe('remove', () => {
    it('removes the project image by tag', async () => {
      const id = addProject('demo');
      await builder.build(id);

      await builder.remove(id);

      expect(engine.removedImages).toEqual([projectImageTag(id)]);
    });

    it('swallows a failure -- the image is hygiene, not correctness', async () => {
      engine.unavailable = true;

      await expect(builder.remove('whatever')).resolves.toBeUndefined();
    });
  });

  describe('resumePending', () => {
    it('builds what a restart left pending', async () => {
      const id = addProject('fresh');

      builder.resumePending();
      await builder.settled();

      expect(imageOf(id)?.status).toBe('ready');
    });

    it('treats a `building` row as the leftover it is', async () => {
      const id = addProject('interrupted');
      // What a killed process leaves behind: no build is running any more, but
      // the row still claims one is.
      repository.setImageState(id, 'building', 'half a log');

      builder.resumePending();
      await builder.settled();

      expect(imageOf(id)?.status).toBe('ready');
      expect(engine.builds).toHaveLength(1);
    });

    it('leaves a failed build alone, so a broken image is not retried in a loop', async () => {
      const id = addProject('broken');
      repository.setImageState(id, 'failed', 'the reason');

      builder.resumePending();
      await builder.settled();

      expect(engine.builds).toEqual([]);
      expect(imageOf(id)).toMatchObject({ status: 'failed', log: 'the reason' });
    });

    it('leaves a ready image alone', async () => {
      const id = addProject('done');
      repository.setImageState(id, 'ready', '', '2026-08-01T00:00:00.000Z');

      builder.resumePending();
      await builder.settled();

      expect(engine.builds).toEqual([]);
    });
  });

  describe('defaultProjectContext', () => {
    it('points at docker/project three levels up, from src and from dist alike', () => {
      // Compared against `resolve` rather than a literal: the dev host is
      // Windows and the separator differs, the path does not.
      const expected = resolve('/repo/docker/project');
      expect(defaultProjectContext('/repo/server/src/projects')).toBe(expected);
      expect(defaultProjectContext('/repo/server/dist/projects')).toBe(expected);
    });
  });
});
