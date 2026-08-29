import fastifyStatic from '@fastify/static';
import websocketPlugin from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { sessionGate } from './auth/gate.ts';
import { authRoutes } from './auth/routes.ts';
import type { SessionAuth } from './auth/session.ts';
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_UPLOAD_LIMITS,
  type InstanceEnvConfig,
  type UploadLimits,
} from './config.ts';
import type { Database } from './db/index.ts';
import { InstanceRepository } from './db/instances.ts';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  DockerUnavailableError,
  FileTooLargeError,
  ImageNotFoundError,
  NotARegularFileError,
  type ContainerLimits,
  type DockerEngine,
} from './docker/engine.ts';
import type { ActivityTracker } from './instances/activity.ts';
import {
  PathNotFoundError,
  PathOutsideWorkspaceError,
  WrongPathKindError,
} from './instances/files.ts';
import { instanceRoutes } from './instances/routes.ts';
import {
  ContainerCommandFailedError,
  ContainerMissingError,
  InstanceService,
  InvalidUploadNameError,
  SessionNotReadyError,
  UnknownChoiceError,
  UploadTooLargeError,
} from './instances/service.ts';
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
import type { StatusTokens } from './status/tokens.ts';
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

/** Fastify's own refusal of an oversized body, which arrives as an ordinary
 *  error with a code rather than as a class this module could `instanceof`. */
function isBodyTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
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
  /** CPU and memory ceiling per instance. Left out, the service falls back to
   *  the same defaults the config does. */
  instanceLimits?: ContainerLimits | undefined;
  /** What may be uploaded into an instance. Same fallback as above. */
  uploadLimits?: UploadLimits | undefined;
  /** The ceiling on one file read back out of an instance. Same fallback. */
  maxReadBytes?: number | undefined;
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
  /** How long a container gets between the text of a slash command and its
   *  Enter. Only the tests set this, for the same reason as the line above. */
  sendKeysPauseMs?: number | undefined;
  /** Gates everything but the login page, the login endpoints and /health. Left
   *  out, the app runs open and says so -- which is what the tests that predate
   *  the login use. The decision to refuse that in production belongs to
   *  loadConfig, which makes CLAUDOPS_LOGIN_SECRET mandatory. */
  auth?: SessionAuth | undefined;
  /** `Secure` on the session cookie. Only with TLS in front: a browser drops a
   *  Secure cookie that arrived over plain http. */
  secureCookie?: boolean | undefined;
  /**
   * Where the instances' hook reports land. Handed in rather than built here
   * because the status listener -- a second app on a second port -- is the half
   * that writes it, and both halves have to share the one map.
   */
  activity?: ActivityTracker | undefined;
  /** Issues the token a container reports with. Together with `statusPort`
   *  this is what puts the three CLAUDOPS_STATUS_* variables into a new
   *  container; without either, instances are created unable to report. */
  statusTokens?: StatusTokens | undefined;
  statusPort?: number | undefined;
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
      // the browser and the log ends up on disk. The cookie carries the session
      // and the body of POST /login carries the shared secret, so both are
      // credentials in exactly the same sense as the PAT.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.gitToken',
          'req.body.secret',
        ],
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

  const uploadLimits = options.uploadLimits ?? DEFAULT_UPLOAD_LIMITS;

  const service = new InstanceService(new InstanceRepository(options.db), options.engine, {
    instanceEnv: options.instanceEnv,
    projects,
    tmuxSession: options.tmuxSession,
    limits: options.instanceLimits,
    uploads: uploadLimits,
    maxReadBytes: options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
    sendKeysPauseMs: options.sendKeysPauseMs,
    activity: options.activity,
    statusTokens: options.statusTokens,
    statusPort: options.statusPort,
  });

  // What a restart interrupted, and what an upgrade left behind: a project from
  // before project images has no image yet, and Docker may be holding
  // containers and volumes of instances that no longer exist. In `onReady`
  // rather than here, so nothing runs for an app that never starts listening.
  app.addHook('onReady', (done) => {
    images.resumePending();

    // Not awaited, and its failure is not fatal: the server deliberately starts
    // while Docker is down, and a leftover is a leftover for one more restart.
    void service.reconcile().then(
      (report) => {
        const cleaned =
          report.removedContainers.length + report.removedVolumes.length + report.endedInstances.length;
        if (cleaned > 0 || report.failures.length > 0) {
          app.log.info(report, 'startup reconcile');
        }
        for (const failure of report.failures) {
          app.log.warn(failure, 'startup reconcile could not remove a leftover');
        }
      },
      (error: unknown) => {
        app.log.warn({ err: error }, 'startup reconcile skipped');
      },
    );

    done();
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DockerUnavailableError) {
      request.log.error({ err: error }, 'Docker Engine unreachable');
      return reply.code(503).send({ error: 'docker_unavailable', message: error.message });
    }
    if (error instanceof ImageNotFoundError) {
      return reply.code(422).send({ error: 'image_not_found', message: error.message });
    }
    // Nothing to stop or start: the row is there, the container is not. 409
    // rather than 404 -- the instance exists, its state is what is in the way,
    // and a restart's reconcile is what clears it.
    if (error instanceof ContainerMissingError || error instanceof ContainerNotFoundError) {
      return reply.code(409).send({ error: 'container_missing', message: error.message });
    }
    // The container exists and is stopped. 409 like the two above -- the
    // instance is there, its state is what is in the way -- but its own code:
    // the way out is Start, not Delete.
    if (error instanceof ContainerNotRunningError) {
      return reply.code(409).send({ error: 'container_not_running', message: error.message });
    }
    // A model or effort value that is in neither list. 400 rather than 422: the
    // route schema rejects the same thing, so a request that gets past it and
    // reaches this is malformed in the same way -- just from a caller that went
    // around the schema.
    if (error instanceof UnknownChoiceError) {
      return reply
        .code(400)
        .send({ error: 'unknown_choice', message: error.message, field: error.field });
    }
    // Nothing to type a slash command into. 409 for the same reading as the two
    // above: the instance is there, its session is what is in the way, and
    // waiting is what clears it.
    if (error instanceof SessionNotReadyError) {
      return reply
        .code(409)
        .send({ error: 'session_not_ready', message: error.message, session: error.readiness });
    }
    // The container was there and refused. 500 rather than 409: nothing about
    // the request was wrong and repeating it is not the fix -- what the command
    // printed is, which is why it travels in the message.
    if (error instanceof ContainerCommandFailedError) {
      request.log.error({ err: error }, 'a command in a container failed');
      return reply
        .code(500)
        .send({ error: 'container_command_failed', message: error.message });
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
    // A path that is not in the workspace, whether it said so plainly or got
    // there through a symlink the container resolved. 400 rather than 404: the
    // answer must not depend on whether the file exists, or the refusal would
    // be a way to ask about the host's filesystem.
    if (error instanceof PathOutsideWorkspaceError) {
      return reply.code(400).send({ error: 'path_outside_workspace', message: error.message });
    }
    // The instance is there and the path in it is not -- a 404 about the path,
    // which is why it does not go through the not-found handler.
    if (error instanceof PathNotFoundError) {
      return reply.code(404).send({ error: 'path_not_found', message: error.message });
    }
    // A directory asked for its bytes, or a file asked for its listing. 400,
    // not 409: no state changes and waiting does not help -- the other
    // endpoint is the answer.
    if (error instanceof WrongPathKindError || error instanceof NotARegularFileError) {
      return reply.code(400).send({ error: 'wrong_path_kind', message: error.message });
    }
    // 413 like an oversized upload, and for the same reason: the client has to
    // ask for something smaller. Decided from the file's size before its bytes
    // are read, so a refusal costs the server nothing.
    if (error instanceof FileTooLargeError) {
      return reply.code(413).send({ error: 'file_too_large', message: error.message });
    }
    // 413 for both ceilings, and for the one Fastify enforces itself: a client
    // that has to shrink a file does not care which of the three refused it.
    // Fastify's own refusal happens before the handler, drops the rest of the
    // body and leaves the connection to the client -- the server stays up.
    if (error instanceof UploadTooLargeError || isBodyTooLarge(error)) {
      return reply.code(413).send({
        error: 'upload_too_large',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (error instanceof InvalidUploadNameError) {
      return reply.code(400).send({ error: 'invalid_filename', message: error.message });
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

  // Before the routes it protects, and on the root instance rather than in each
  // plugin: the static wildcard below and the not-found handler above need it
  // too, and "closed unless listed" is the only default worth having.
  const auth = options.auth;
  const secureCookie = options.secureCookie ?? false;
  if (auth === undefined) {
    app.log.warn('no login configured -- every endpoint is open');
  } else {
    app.addHook('onRequest', sessionGate(auth, secureCookie));
  }

  // The console is a raw duplex, not JSON over HTTP: @fastify/websocket brings
  // the upgrade handling and `ws`, the bridge in src/terminal does the piping.
  void app.register(websocketPlugin, { options: { maxPayload: MAX_WS_PAYLOAD } });

  if (auth !== undefined) void app.register(authRoutes, { auth, secureCookie });

  void app.register(projectRoutes, { service: projects, images });
  void app.register(instanceRoutes, { service, maxUploadBytes: uploadLimits.maxFileBytes });
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
