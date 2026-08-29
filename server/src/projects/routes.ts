import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import type { ProjectImages } from './images.ts';
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

/** A name a shell would accept, which is also what `${VAR}` in a repository's
 *  `.mcp.json` looks up. The service checks the same thing, and additionally
 *  which names claudops manages itself -- that list belongs next to the code
 *  that writes them, not in a schema. */
const ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]{0,127}$';

/** Long enough for a connection string or a JWT, short enough that a project
 *  cannot be used as a file store. */
const ENV_VALUE_MAX = 4096;

/** A map rather than a list of `{name, value}` objects: the name is the key
 *  here, in the container and in `${VAR}`, and a list would make "the same
 *  variable twice" expressible. */
const createEnvSchema = {
  type: 'object',
  propertyNames: { pattern: ENV_NAME_PATTERN },
  additionalProperties: { type: 'string', maxLength: ENV_VALUE_MAX },
  maxProperties: 100,
} as const;

/** The PATCH variant, where `null` removes one variable. */
const updateEnvSchema = {
  ...createEnvSchema,
  additionalProperties: { type: ['string', 'null'], maxLength: ENV_VALUE_MAX },
} as const;

/** Hosts and CIDRs. Only their shape is checked here -- what the firewall could
 *  actually do with an entry is projects/env.ts, which the service calls. */
const egressHostsSchema = {
  type: 'array',
  maxItems: 50,
  items: { type: 'string', minLength: 1, maxLength: 253 },
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
    // Sealed like the PAT and never sent back: the response carries `envNames`.
    env: createEnvSchema,
    egressHosts: egressHostsSchema,
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
    env: updateEnvSchema,
    egressHosts: egressHostsSchema,
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

export interface ProjectRoutesOptions extends FastifyPluginOptions {
  service: ProjectService;
  /** Where a build is asked for. The service itself stays free of Docker: it
   *  only ever writes `pending`, and a `pending` answer is the signal. */
  images: ProjectImages;
}

export const projectRoutes: FastifyPluginCallback<ProjectRoutesOptions> = (app, options, done) => {
  const { service, images } = options;

  app.post<{ Body: CreateProjectInput }>(
    '/projects',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const project = service.create(request.body);
      // Started, not awaited: a dotnet plus Playwright build takes minutes and
      // the caller gets `image.status: "pending"` to watch instead.
      images.request(project.id);
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
        const project = service.update(request.params.id, request.body);
        // Changed building blocks put the image back to `pending`; a rename or a
        // new PAT does not, because neither changes the image.
        if (project.image.status === 'pending') images.request(project.id);
        return project;
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  /** An explicit rebuild -- and the only way out of `failed`, which no build
   *  clears on its own. `202`: accepted, not finished. */
  app.post<{ Params: { id: string } }>(
    '/projects/:id/build',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        const project = service.requeueImage(request.params.id);
        images.request(project.id);
        return await reply.code(202).send(project);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  /** Its own endpoint rather than a field on the project: a build log runs to
   *  tens of kilobytes, and the project list asks for every project at once. */
  app.get<{ Params: { id: string } }>(
    '/projects/:id/build-log',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        return service.buildLog(request.params.id);
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
        // After the row, and best effort: the image is hygiene, and a tag that
        // stayed behind must not turn a successful delete into a 500.
        await images.remove(request.params.id);
        return await reply.code(204).send();
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.callNotFound();
        throw error;
      }
    },
  );

  done();
};
