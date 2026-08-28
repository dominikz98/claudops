import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import {
  InstanceNotFoundError,
  type CreateInstanceInput,
  type InstanceService,
} from './service.ts';

// Repository, branch and PAT live on the project now. With
// additionalProperties: false a caller still sending `gitToken` gets a 400
// rather than a silently ignored field
// (knowledge/fastify-strips-unknown-fields.md).
const createBodySchema = {
  type: 'object',
  required: ['name', 'projectId'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    projectId: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

/** The upload carries its name in the query, not in the body -- the body is
 *  the file itself. 255 is what a Linux filename may be; what survives of it is
 *  `uploadFileName`'s decision, not this schema's. */
const uploadQuerySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 255 } },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

export interface InstanceRoutesOptions extends FastifyPluginOptions {
  service: InstanceService;
  /** The per-file upload ceiling, as the route's own `bodyLimit`. It has to be
   *  known here rather than in the handler: Fastify refuses an oversized body
   *  before any handler runs, which is the only place it can be refused without
   *  buffering it first. */
  maxUploadBytes: number;
}

/** Registering routes needs no I/O, so this is a callback plugin rather than
 *  an async one Fastify would have to await for nothing. */
export const instanceRoutes: FastifyPluginCallback<InstanceRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;

  // Fastify parses application/json and text/plain and nothing else, so without
  // this an upload answers 415. `parseAs: 'buffer'` hands the handler the bytes
  // and keeps the route's bodyLimit in force while they are read
  // (knowledge/a-raw-upload-needs-a-parser-and-its-own-bodylimit.md).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

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

  // POST rather than a PATCH of a status field: the instance table has no
  // status to patch. Both ask Docker to do something and answer with what
  // Docker reports afterwards
  // (knowledge/database-holds-identity-docker-holds-state.md).
  app.post<{ Params: { id: string } }>(
    '/instances/:id/stop',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        return await service.stop(request.params.id);
      } catch (error) {
        if (error instanceof InstanceNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/instances/:id/start',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        return await service.start(request.params.id);
      } catch (error) {
        if (error instanceof InstanceNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  /**
   * One file per request, the bytes as the body and the name in the query. No
   * multipart: a single file needs no envelope, and the route's own bodyLimit
   * is what refuses an oversized one before it is read.
   */
  app.post<{ Params: { id: string }; Querystring: { name: string }; Body: Buffer }>(
    '/instances/:id/files',
    {
      // Fastify's default is one megabyte, which is a small screenshot.
      bodyLimit: options.maxUploadBytes,
      schema: { params: idParamsSchema, querystring: uploadQuerySchema },
    },
    async (request, reply) => {
      // Fastify parses application/json and text/plain itself, so a caller with
      // the wrong content type would hand the service a string. The body of an
      // upload is bytes or it is nothing.
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: 'send the file as application/octet-stream',
        });
      }

      try {
        const upload = await service.upload(request.params.id, {
          name: request.query.name,
          content: request.body,
        });
        return await reply.code(201).send(upload);
      } catch (error) {
        if (error instanceof InstanceNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  done();
};
