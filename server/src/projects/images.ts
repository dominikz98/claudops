import { resolve } from 'node:path';
import type { ProjectRepository } from '../db/projects.ts';
import type { DockerEngine, ImageBuildSpec } from '../docker/engine.ts';
import { projectImageTag, projectLabels } from '../docker/labels.ts';
import type { ProjectBuildSpec, ProjectService } from './service.ts';

/**
 * Builds the image a project's instances start from: `docker/project/Dockerfile`
 * on top of `claudops-base`, with one layer per building block.
 *
 * Builds are asynchronous. A dotnet SDK plus a Chromium install takes minutes,
 * and a REST call cannot hold that open -- so `POST /projects` answers straight
 * away with `pending` and the work happens here. What makes that safe is the
 * gate on the other side: an instance cannot start before its project's image is
 * `ready` (ProjectImageNotReadyError).
 */

/** The part of the builder the routes use. Keeps them from depending on the
 *  Docker engine just to say "this project needs building". */
export interface ProjectImages {
  request(projectId: string): void;
  remove(projectId: string): Promise<void>;
  /** Picks up the builds a restart or an upgrade left behind. */
  resumePending(): void;
}

/** Just enough of Fastify's logger to report a build without depending on it. */
export interface ImageBuildLogger {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface ProjectImageOptions {
  /** Directory holding the template Dockerfile. */
  contextDir: string;
  /** What the template builds `FROM`. */
  baseImage: string;
  /** Channel for dotnet-install.sh, e.g. `10.0` or `LTS`. */
  dotnetChannel: string;
  logger: ImageBuildLogger;
  /** Cap on the stored log. A `playwright install --with-deps` alone writes
   *  thousands of lines, and the database is not a log server. */
  maxLogBytes?: number;
  now?: () => Date;
}

const DOCKERFILE = 'Dockerfile';

/** 64 KiB is several hundred lines -- enough to see which step failed and why,
 *  which is the only reason the log is kept. */
const DEFAULT_MAX_LOG_BYTES = 64 * 1024;

/**
 * Where the template lives, resolved from this module's own location rather than
 * from the working directory -- the server is started from the repository root
 * by hand and from `server/` by the smoke tests, and it is three levels up
 * either way, as `server/src/projects` in development and `server/dist/projects`
 * after a build.
 */
export function defaultProjectContext(here: string = import.meta.dirname): string {
  return resolve(here, '../../../docker/project');
}

/** Docker build args are strings; the blocks are flags. */
function buildArgFor(enabled: boolean): string {
  return enabled ? '1' : '0';
}

/**
 * Collects the daemon's output but keeps only the tail. The failing step is at
 * the end, and the beginning of a `playwright install --with-deps` is thousands
 * of lines the database has no business holding.
 */
class BuildLog {
  private readonly chunks: string[] = [];
  private size = 0;
  private dropped = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    this.chunks.push(chunk);
    this.size += chunk.length;

    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const gone = this.chunks.shift()?.length ?? 0;
      this.size -= gone;
      this.dropped += gone;
    }
  }

  /** What gets stored: the tail, with a line saying what is missing rather than
   *  a log that silently starts mid-step. */
  text(): string {
    let kept = this.chunks.join('');
    let dropped = this.dropped;

    // A single chunk can be larger than the cap on its own.
    if (kept.length > this.maxBytes) {
      dropped += kept.length - this.maxBytes;
      kept = kept.slice(-this.maxBytes);
    }

    return dropped === 0 ? kept : `[... ${String(dropped)} bytes cut]\n${kept}`;
  }
}

export class ProjectImageBuilder implements ProjectImages {
  private readonly options: ProjectImageOptions;
  private readonly maxLogBytes: number;
  private readonly now: () => Date;

  /**
   * Builds run one after another. The NUC has one Docker daemon and a handful of
   * cores; three parallel image builds would take longer than three sequential
   * ones and starve everything else running on the box.
   */
  private queue: Promise<void> = Promise.resolve();
  /** Projects already waiting in `queue`, so a burst of PATCHes does not queue
   *  the same build five times. */
  private readonly queued = new Set<string>();

  constructor(
    private readonly projects: ProjectService,
    private readonly repository: ProjectRepository,
    private readonly engine: DockerEngine,
    options: ProjectImageOptions,
  ) {
    this.options = options;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  /** Fire and forget: the caller is answering an HTTP request and must not wait
   *  for a build. Failures are recorded on the project, not thrown here. */
  request(projectId: string): void {
    if (this.queued.has(projectId)) return;
    this.queued.add(projectId);
    this.queue = this.queue.then(() => this.build(projectId));
  }

  /** Waits for everything queued so far. For the tests and for a shutdown that
   *  would rather not cut a build in half. */
  async settled(): Promise<void> {
    await this.queue;
  }

  /**
   * Builds one project's image and records the outcome. Never throws: a failed
   * build is a state of the project, not an error of whoever asked for it.
   */
  async build(projectId: string): Promise<void> {
    this.queued.delete(projectId);

    let spec: ProjectBuildSpec;
    try {
      spec = this.projects.buildSpec(projectId);
    } catch {
      // Deleted while it sat in the queue -- nothing left to build.
      return;
    }

    this.repository.setImageState(projectId, 'building', null);
    this.options.logger.info(
      { projectId, image: spec.tag, buildingBlocks: spec.buildingBlocks },
      'building project image',
    );

    const log = new BuildLog(this.maxLogBytes);

    try {
      await this.engine.buildImage(this.specFor(spec), (chunk) => {
        log.append(chunk);
      });
    } catch (error) {
      // The reason goes into the log next to the output: that is the one place
      // anybody looking at a failed build will read.
      log.append(`\n${error instanceof Error ? error.message : String(error)}\n`);
      this.repository.setImageState(projectId, 'failed', log.text());
      this.options.logger.error({ projectId, image: spec.tag, err: error }, 'project image failed');
      return;
    }

    this.repository.setImageState(projectId, 'ready', log.text(), this.now().toISOString());
    this.options.logger.info({ projectId, image: spec.tag }, 'project image ready');
  }

  /** Best effort. The image is hygiene: a project delete that already removed
   *  the row must not answer 500 because a tag stayed behind. */
  async remove(projectId: string): Promise<void> {
    const tag = projectImageTag(projectId);
    try {
      await this.engine.removeImage(tag);
    } catch (error) {
      this.options.logger.warn(
        { projectId, image: tag, err: error },
        'could not remove the project image',
      );
    }
  }

  /**
   * Picks up what a restart interrupted. `building` is always a leftover -- no
   * build survives the process that ran it -- so it goes back to `pending` and
   * is queued along with everything else waiting.
   *
   * `failed` is deliberately left alone: retrying it on every start would spin a
   * broken Dockerfile in a loop. `POST /projects/:id/build` is the way back.
   */
  resumePending(): void {
    for (const id of this.repository.idsWithImageStatus('building')) {
      this.repository.setImageState(id, 'pending', null);
    }

    const pending = this.repository.idsWithImageStatus('pending');
    if (pending.length === 0) return;

    this.options.logger.info({ projects: pending.length }, 'queueing project image builds');
    for (const id of pending) this.request(id);
  }

  private specFor(spec: ProjectBuildSpec): ImageBuildSpec {
    const blocks = spec.buildingBlocks;
    return {
      tag: spec.tag,
      contextDir: this.options.contextDir,
      dockerfile: DOCKERFILE,
      buildArgs: {
        BASE_IMAGE: this.options.baseImage,
        WITH_DOTNET: buildArgFor(blocks.dotnet),
        WITH_PLAYWRIGHT: buildArgFor(blocks.playwright),
        DOTNET_CHANNEL: this.options.dotnetChannel,
      },
      labels: projectLabels(spec.id),
    };
  }
}
