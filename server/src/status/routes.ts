import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import type { InstanceRepository } from '../db/instances.ts';
import { HOOK_EVENTS, type ActivityReport, type ActivityTracker } from '../instances/activity.ts';
import type { StatusTokens } from './tokens.ts';

/**
 * The one route an instance container may reach on the host.
 *
 * It takes a hook report and writes it into the tracker. It reads nothing back,
 * it touches no container, and it is the whole surface of the port it listens
 * on -- which is what makes opening that port in the container's egress
 * firewall a different proposition from opening the API's
 * (knowledge/the-status-port-is-the-one-hole-in-the-egress-firewall.md).
 */

const bodySchema = {
  type: 'object',
  required: ['event'],
  additionalProperties: false,
  properties: {
    event: { enum: [...HOOK_EVENTS] },
    /** `notification_type` from the hook's stdin. Only `Notification` has one,
     *  and a release that adds a value must not turn into a 400 here -- so any
     *  short string is accepted and the tracker decides what it means. */
    notificationType: { type: 'string', maxLength: 64 },
  },
} as const;

const paramsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

/** `Bearer <token>`, or nothing at all. Case-insensitive on the scheme, which
 *  is what RFC 7235 says and what a shell script eventually gets wrong. */
function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export interface StatusRoutesOptions extends FastifyPluginOptions {
  instances: InstanceRepository;
  activity: ActivityTracker;
  tokens: StatusTokens;
}

export const statusRoutes: FastifyPluginCallback<StatusRoutesOptions> = (app, options, done) => {
  const { instances, activity, tokens } = options;

  app.post<{ Params: { id: string }; Body: ActivityReport }>(
    '/instances/:id/status',
    { schema: { params: paramsSchema, body: bodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const token = bearer(request.headers.authorization);

      // Verified before the instance is looked up, and the answer is the same
      // either way: the token is derived from the id, so a caller who has one
      // for an id the server does not know is not a case worth distinguishing
      // from a caller who has none.
      if (token === undefined || !tokens.verify(id, token)) {
        request.log.warn({ id }, 'status report with no valid token');
        return reply.code(401).send({ error: 'unauthorized', message: 'invalid status token' });
      }

      if (instances.get(id) === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such instance' });
      }

      activity.record(id, request.body);
      // Nothing to answer with, and a hook that waits for a body is a hook that
      // slows down a turn. SessionEnd in particular shares a 1.5s budget with
      // every other SessionEnd hook.
      return await reply.code(204).send();
    },
  );

  done();
};
