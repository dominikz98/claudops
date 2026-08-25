import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import {
  ProjectNotFoundError,
  type CreateProjectInput,
  type ProjectService,
  type UpdateProjectInput,
} from './service.ts';

const buildingBlocksSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dotnet: { type: 'boolean' },
    playwright: { type: 'boolean' },
  },
} as const;

const createBodySchema = {
  type: 'object',
  required: ['name', 'repoUrl'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    repoUrl: { type: 'string', minLength: 1, maxLength: 500 },
    repoBranch: { type: 'string', minLength: 1, maxLength: 200 },
    // Encrypted before it is stored and never sent back -- the response carries
    // `hasGitToken` instead.
    gitToken: { type: 'string', minLength: 1, maxLength: 500 },
    buildingBlocks: buildingBlocksSchema,
  },
} as const;

/** A PATCH: every field optional, but not an empty body -- that would be a
 *  request that means nothing and still bumps `updatedAt`. `null` on a nullable
 *  field is the explicit removal. */
const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    repoUrl: { type: 'string', minLength: 1, maxLength: 500 },
    repoBranch: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
    gitToken: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
    buildingBlocks: buildingBlocksSchema,
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

export interface ProjectRoutesOptions extends FastifyPluginOptions {
  service: ProjectService;
}

export const projectRoutes: FastifyPluginCallback<ProjectRoutesOptions> = (app, options, done) => {
  const { service } = options;

  app.post<{ Body: CreateProjectInput }>(
    '/projects',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const project = service.create(request.body);
      return reply.code(201).header('location', `/projects/${project.id}`).send(project);
    },
  );

  // Not async, unlike the instance list: nothing here waits on Docker, and an
  // async handler with no await is a lie about that.
  app.get('/projects', () => ({ projects: service.list() }));

  app.get<{ Params: { id: string } }>(
    '/projects/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        return service.get(request.params.id);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateProjectInput }>(
    '/projects/:id',
    { schema: { params: idParamsSchema, body: updateBodySchema } },
    async (request, reply) => {
      try {
        return service.update(request.params.id, request.body);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/projects/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        service.delete(request.params.id);
        return await reply.code(204).send();
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  done();
};
