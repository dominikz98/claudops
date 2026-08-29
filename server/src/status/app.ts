import Fastify, { type FastifyInstance } from 'fastify';
import type { InstanceRepository } from '../db/instances.ts';
import type { ActivityTracker } from '../instances/activity.ts';
import { statusRoutes } from './routes.ts';
import type { StatusTokens } from './tokens.ts';

/**
 * The listener instance containers report to -- its own Fastify app on its own
 * port, next to the one the browser talks to.
 *
 * A second port rather than a second route on the first one, and that is the
 * whole point of this file. The container's egress firewall filters by address
 * and port; it cannot filter by path. Putting this route on the API's port
 * would mean opening that port, and with it `POST /login` as a brute-force
 * target and the SPA and every future endpoint -- for a container that is
 * supposed to reach whitelisted domains and nothing else. On its own port the
 * hole in the firewall is exactly one route wide.
 *
 * There is no session gate here on purpose: the credential is the per-instance
 * token in the Authorization header, and a browser session would be the wrong
 * one entirely -- nobody is logged in inside a container.
 */

export interface StatusAppOptions {
  /** Read-only here: the route only asks whether an id exists. */
  instances: InstanceRepository;
  /** The same tracker the instance service reads its views from. */
  activity: ActivityTracker;
  tokens: StatusTokens;
  logLevel?: string | undefined;
}

export function buildStatusApp(options: StatusAppOptions): FastifyInstance {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    logger: {
      level: options.logLevel ?? 'info',
      // The status token is a credential in exactly the same sense as the
      // session cookie, and this app logs a rejected report by design.
      redact: { paths: ['req.headers.authorization'], censor: '[redacted]' },
    },
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'no such route' }),
  );

  app.setErrorHandler((error: unknown, request, reply) => {
    const validation = (error as { validation?: unknown }).validation;
    if (validation !== undefined) {
      const message = error instanceof Error ? error.message : 'invalid request';
      return reply.code(400).send({ error: 'invalid_request', message });
    }

    request.log.error({ err: error }, 'unhandled error on the status port');
    return reply.code(500).send({ error: 'internal_error', message: 'internal server error' });
  });

  void app.register(statusRoutes, {
    instances: options.instances,
    activity: options.activity,
    tokens: options.tokens,
  });

  return app;
}
