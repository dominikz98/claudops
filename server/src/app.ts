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

export interface AppOptions {
  db: Database;
  engine: DockerEngine;
  baseImage: string;
  instanceEnv: InstanceEnvConfig;
  logLevel?: string;
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

  const service = new InstanceService(new InstanceRepository(options.db), options.engine, {
    baseImage: options.baseImage,
    instanceEnv: options.instanceEnv,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DockerUnavailableError) {
      request.log.error({ err: error }, 'Docker Engine unreachable');
      return reply.code(503).send({ error: 'docker_unavailable', message: error.message });
    }
    if (error instanceof ImageNotFoundError) {
      return reply.code(422).send({ error: 'image_not_found', message: error.message });
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

  void app.register(instanceRoutes, { service });

  return app;
}
