import fastifyStatic from '@fastify/static';
import websocketPlugin from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { InstanceEnvConfig } from './config.ts';
import type { Database } from './db/index.ts';
import { InstanceRepository } from './db/instances.ts';
import {
  DockerUnavailableError,
  ImageNotFoundError,
  type DockerEngine,
} from './docker/engine.ts';
import { instanceRoutes } from './instances/routes.ts';
import { InstanceService } from './instances/service.ts';
import { ProjectRepository } from './db/projects.ts';
import {
  defaultProjectContext,
  ProjectImageBuilder,
  type ProjectImages,
} from './projects/images.ts';
import { projectRoutes } from './projects/routes.ts';
import {
  ProjectImageNotReadyError,
  ProjectInUseError,
  ProjectNameTakenError,
  ProjectNotFoundError,
  ProjectService,
} from './projects/service.ts';
import {
  createCipher,
  SecretKeyMissingError,
  SecretUndecryptableError,
  type SecretCipher,
} from './secrets/cipher.ts';
import type { BridgeOptions } from './terminal/bridge.ts';
import { terminalRoutes } from './terminal/routes.ts';

interface HttpError {
  statusCode: number | undefined;
  validation: unknown;
  message: string;
}

function asHttpError(error: unknown): HttpError {
  const source = (typeof error === 'object' && error !== null ? error : {}) as Record<
    string,
    unknown
  >;

  return {
    statusCode: typeof source.statusCode === 'number' ? source.statusCode : undefined,
    validation: source.validation,
    message: typeof source.message === 'string' ? source.message : String(error),
  };
}

/** Keystrokes and the occasional paste -- a megabyte is already generous, and a
 *  cap keeps a rogue client from making the server buffer without bound. */
const MAX_WS_PAYLOAD = 1024 * 1024;

/** Mirrors the config default; buildApp is also called without a full config. */
const DEFAULT_DOTNET_CHANNEL = '10.0';

export interface AppOptions {
  db: Database;
  engine: DockerEngine;
  /** What a project image is built `FROM`. Instances start from their project's
   *  image, which this server builds. */
  baseImage: string;
  /** Directory holding the project template Dockerfile. Defaults to
   *  `docker/project` next to this package. */
  projectContext?: string | undefined;
  /** Channel for the dotnet building block. */
  dotnetChannel?: string | undefined;
  /** Only the tests replace this, to keep real image builds out of a unit
   *  test. */
  images?: ProjectImages | undefined;
  instanceEnv: InstanceEnvConfig;
  /** Encrypts the project PATs. Left out, the server runs but refuses to store
   *  one -- the same behaviour as a missing CLAUDOPS_SECRET_KEY. */
  cipher?: SecretCipher | undefined;
  /** Directory the built web UI is served from. Left out, or pointing at a
   *  directory without an `index.html`, the server runs API-only. */
  webRoot?: string | undefined;
  tmuxSession?: string | undefined;
  logLevel?: string;
  /** Only the tests set this, to keep the terminal heartbeat out of real time. */
  terminalBridge?: BridgeOptions | undefined;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    // Fastify's Ajv default is removeAdditional: true, which drops an unknown
    // field silently and answers 201. A caller who sends `env` or a misspelled
    // key would never learn it did nothing -- so reject instead of strip.
    ajv: { customOptions: { removeAdditional: false } },
    logger: {
      level: options.logLevel ?? 'info',
      // A token in a log line is a leaked token: the console is mirrored into
      // the browser and the log ends up on disk.
      redact: {
        paths: ['req.headers.authorization', 'req.body.gitToken'],
        censor: '[redacted]',
      },
    },
  });

  const projectRepository = new ProjectRepository(options.db);
  const projects = new ProjectService(projectRepository, {
    cipher: options.cipher ?? createCipher(undefined),
  });

  // Built here rather than handed in, because the logger it reports through is
  // this app's. A test can still pass its own.
  const images =
    options.images ??
    new ProjectImageBuilder(projects, projectRepository, options.engine, {
      contextDir: options.projectContext ?? defaultProjectContext(),
      baseImage: options.baseImage,
      dotnetChannel: options.dotnetChannel ?? DEFAULT_DOTNET_CHANNEL,
      logger: app.log,
    });

  // What a restart interrupted, and what an upgrade left behind: a project from
  // before project images has no image yet. In `onReady` rather than here, so
  // nothing is queued for an app that never starts listening.
  app.addHook('onReady', (done) => {
    images.resumePending();
    done();
  });

  const service = new InstanceService(new InstanceRepository(options.db), options.engine, {
    instanceEnv: options.instanceEnv,
    projects,
    tmuxSession: options.tmuxSession,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DockerUnavailableError) {
      request.log.error({ err: error }, 'Docker Engine unreachable');
      return reply.code(503).send({ error: 'docker_unavailable', message: error.message });
    }
    if (error instanceof ImageNotFoundError) {
      return reply.code(422).send({ error: 'image_not_found', message: error.message });
    }
    // Only reachable from POST /instances: the project routes answer 404 for an
    // id in their own path. An unknown reference in a body is a 422, the same
    // reading as a base image that was never built.
    if (error instanceof ProjectNotFoundError) {
      return reply.code(422).send({ error: 'project_not_found', message: error.message });
    }
    // 422, the same reading as a base image that was never built: the request
    // was understood, the environment it needs does not exist yet.
    if (error instanceof ProjectImageNotReadyError) {
      return reply
        .code(422)
        .send({ error: 'project_image_not_ready', message: error.message, status: error.status });
    }
    if (error instanceof ProjectInUseError) {
      return reply.code(409).send({ error: 'project_in_use', message: error.message });
    }
    if (error instanceof ProjectNameTakenError) {
      return reply.code(409).send({ error: 'project_name_taken', message: error.message });
    }
    // Both messages name the variable rather than the secret: the caller needs
    // to know the server cannot hold a PAT, not what the PAT was.
    if (error instanceof SecretKeyMissingError) {
      return reply.code(422).send({ error: 'secret_key_missing', message: error.message });
    }
    if (error instanceof SecretUndecryptableError) {
      return reply.code(422).send({ error: 'secret_undecryptable', message: error.message });
    }

    // Fastify hands the handler an `unknown` -- a route can throw anything.
    const { statusCode, validation, message } = asHttpError(error);

    if (validation !== undefined) {
      return reply.code(400).send({ error: 'invalid_request', message });
    }

    request.log.error({ err: error }, 'unhandled error');
    const status = statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_failed',
      // A 5xx message can carry internals -- the log has the detail.
      message: status >= 500 ? 'internal server error' : message,
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'no such route or instance' }),
  );

  // Readiness, not just liveness: without it a caller cannot tell "server up"
  // from "server up but Docker gone", and the smoke test would poll blind.
  app.get('/health', async (_request, reply) => {
    try {
      await options.engine.ping();
    } catch (error) {
      return reply.code(503).send({
        status: 'degraded',
        docker: 'unreachable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { status: 'ok', docker: 'ok' };
  });

  // The console is a raw duplex, not JSON over HTTP: @fastify/websocket brings
  // the upgrade handling and `ws`, the bridge in src/terminal does the piping.
  void app.register(websocketPlugin, { options: { maxPayload: MAX_WS_PAYLOAD } });

  void app.register(projectRoutes, { service: projects, images });
  void app.register(instanceRoutes, { service });
  void app.register(terminalRoutes, { service, bridge: options.terminalBridge });

  // The SPA shares the port with the API. Exact routes win against the
  // wildcard this registers, and the SPA keeps its own routes in the hash, so
  // nothing here shadows `/instances`
  // (knowledge/spa-hash-routing-avoids-the-api-namespace.md).
  const webRoot = options.webRoot;
  if (webRoot !== undefined && existsSync(join(webRoot, 'index.html'))) {
    void app.register(fastifyStatic, { root: webRoot, prefix: '/', index: 'index.html' });
  } else {
    // Not fatal: an unbuilt UI is a missing convenience, not a broken server --
    // the same reasoning that lets it start while Docker is down.
    app.log.warn({ webRoot }, 'no built web UI found -- serving the API only');
  }

  return app;
}
