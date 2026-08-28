import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import {
  INSTANCE_EFFORTS,
  INSTANCE_MODELS,
  InstanceNotFoundError,
  type CreateInstanceInput,
  type InstanceService,
  type ModelChoiceChanges,
} from './service.ts';

// `null` is a member of both enums on purpose: it is the third legitimate value
// -- "whatever Claude Code picks itself" -- and without it in the list a caller
// resetting a choice would get a 400.
const modelSchema = { enum: [...INSTANCE_MODELS, null] } as const;
const effortSchema = { enum: [...INSTANCE_EFFORTS, null] } as const;

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
    model: modelSchema,
    effort: effortSchema,
  },
} as const;

/** Both optional: a field that is not sent keeps its stored value, exactly like
 *  `PATCH /projects/:id`. */
const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { model: modelSchema, effort: effortSchema },
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

  /**
   * The one thing on an instance that *is* stored and can be changed. A PATCH
   * rather than another `POST /:id/...` for exactly that reason -- and the same
   * reason the two below are not PATCHes.
   *
   * A switch needs a session to type into, so a stopped or still-starting
   * instance is refused with 409 rather than half-applied. A PATCH that changes
   * nothing is not refused: it never touches the container.
   */
  app.patch<{ Params: { id: string }; Body: ModelChoiceChanges }>(
    '/instances/:id',
    { schema: { params: idParamsSchema, body: patchBodySchema } },
    async (request, reply) => {
      try {
        return await service.setModelEffort(request.params.id, request.body);
      } catch (error) {
        // Everything else -- an unknown value, a missing container, a session
        // that is not up -- has its answer in the error handler in app.ts.
        if (error instanceof InstanceNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  // POST rather than a PATCH of a status field: neither stop nor start writes
  // anything. Both ask Docker to do something and answer with what Docker
  // reports afterwards
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
