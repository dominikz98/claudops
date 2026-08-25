import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import { InstanceNotFoundError, type CreateInstanceInput, type InstanceService } from './service.ts';

const createBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    repoUrl: { type: 'string', minLength: 1, maxLength: 500 },
    repoBranch: { type: 'string', minLength: 1, maxLength: 200 },
    // Passed through to the container, never persisted and never echoed back.
    gitToken: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

export interface InstanceRoutesOptions extends FastifyPluginOptions {
  service: InstanceService;
}

/** Registering routes needs no I/O, so this is a callback plugin rather than
 *  an async one Fastify would have to await for nothing. */
export const instanceRoutes: FastifyPluginCallback<InstanceRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;

  app.post<{ Body: CreateInstanceInput }>(
    '/instances',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const instance = await service.create(request.body);
      return reply.code(201).header('location', `/instances/${instance.id}`).send(instance);
    },
  );

  app.get('/instances', async () => ({ instances: await service.list() }));

  app.get<{ Params: { id: string } }>(
    '/instances/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        return await service.get(request.params.id);
      } catch (error) {
        if (error instanceof InstanceNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/instances/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        await service.delete(request.params.id);
        return await reply.code(204).send();
      } catch (error) {
        if (error instanceof InstanceNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  done();
};
