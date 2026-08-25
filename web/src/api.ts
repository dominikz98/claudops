/**
 * The REST half of the server, typed. The terminal half is a WebSocket and
 * lives in `terminal/session.ts`.
 *
 * `fetch` is a parameter rather than a global so the tests can drive this
 * without a browser and without a server.
 */

/** `InstanceView` in server/src/instances/service.ts. No token field exists on
 *  purpose -- the server never gives one back. */
export interface Instance {
  id: string;
  name: string;
  image: string;
  containerId: string | null;
  /** The project it was created from. `null` only for rows older than #6. */
  projectId: string | null;
  /** What the container was actually told to clone, snapshotted at create time
   *  -- not a live view of the project. */
  repoUrl: string | null;
  repoBranch: string | null;
  createdAt: string;
  /** Raw Docker state -- running, exited, created, ... -- or `missing`. */
  status: string;
}

export interface CreateInstanceInput {
  name: string;
  /** Repository, branch and PAT all come from the project. */
  projectId: string;
}

/** The optional layers a project image is built with. */
export interface BuildingBlocks {
  dotnet: boolean;
  playwright: boolean;
}

/** Where the project's image stands. `ready` is the only state an instance can
 *  be created from -- the environment is prebuilt, so there is nothing to fall
 *  back to. */
export type ImageStatus = 'pending' | 'building' | 'ready' | 'failed';

export interface ProjectImage {
  /** The tag, whether or not it exists yet. */
  tag: string;
  status: ImageStatus;
  builtAt: string | null;
}

/** `GET /projects/:id/build-log`. Its own request because a build log runs to
 *  tens of kilobytes and the project list asks for all of them at once. */
export interface BuildLog {
  status: ImageStatus;
  builtAt: string | null;
  log: string;
}

/** `ProjectView` in server/src/projects/service.ts. The PAT appears only as
 *  `hasGitToken`: it is stored encrypted server-side and never sent back. */
export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  repoBranch: string | null;
  buildingBlocks: BuildingBlocks;
  image: ProjectImage;
  hasGitToken: boolean;
  instanceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  repoBranch?: string;
  gitToken?: string;
  buildingBlocks: BuildingBlocks;
}

export interface UpdateProjectInput {
  name?: string;
  repoUrl?: string;
  /** `null` clears the branch and falls back to the container default. */
  repoBranch?: string | null;
  /** Left out the stored PAT stays -- which is what an empty password field
   *  means. `null` removes it, a string replaces it. */
  gitToken?: string | null;
  buildingBlocks?: BuildingBlocks;
}

/** A request the server answered with an error body: `{ error, message }`. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export interface Api {
  list(): Promise<Instance[]>;
  get(id: string): Promise<Instance>;
  create(input: CreateInstanceInput): Promise<Instance>;
  remove(id: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(id: string, input: UpdateProjectInput): Promise<Project>;
  removeProject(id: string): Promise<void>;
  /** Asks for a rebuild. Answers before the build has run -- watch
   *  `image.status`. */
  buildProject(id: string): Promise<Project>;
  projectBuildLog(id: string): Promise<BuildLog>;
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
}

async function failure(response: Response): Promise<ApiCallError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A proxy or a crash can answer with something that is not JSON; the status
    // is still worth reporting.
  }
  const code = typeof body.error === 'string' ? body.error : 'request_failed';
  const message = typeof body.message === 'string' ? body.message : response.statusText;
  return new ApiCallError(response.status, code, message);
}

/** Blank optional fields are dropped rather than sent: the server validates
 *  `minLength: 1` and would answer 400 for an empty string. An explicit `null`
 *  is kept, because that is the removal. */
function withoutBlanks(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== ''),
  );
}

export function createApi(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Api {
  /** Every call goes through here, so an error body is turned into an
   *  ApiCallError in exactly one place. */
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(path, init);
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  };

  const send = (method: string, body: Record<string, unknown>): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** DELETE answers 204 with no body, so it cannot go through `request`. */
  const remove = async (path: string): Promise<void> => {
    const response = await fetchImpl(path, { method: 'DELETE' });
    if (!response.ok) throw await failure(response);
  };

  return {
    async list(): Promise<Instance[]> {
      return (await request<{ instances: Instance[] }>('/instances')).instances;
    },

    get(id: string): Promise<Instance> {
      return request<Instance>(`/instances/${encodeURIComponent(id)}`);
    },

    create(input: CreateInstanceInput): Promise<Instance> {
      return request<Instance>(
        '/instances',
        send('POST', { name: input.name, projectId: input.projectId }),
      );
    },

    remove(id: string): Promise<void> {
      return remove(`/instances/${encodeURIComponent(id)}`);
    },

    async listProjects(): Promise<Project[]> {
      return (await request<{ projects: Project[] }>('/projects')).projects;
    },

    createProject(input: CreateProjectInput): Promise<Project> {
      return request<Project>(
        '/projects',
        send(
          'POST',
          withoutBlanks({
            name: input.name,
            repoUrl: input.repoUrl,
            repoBranch: input.repoBranch,
            gitToken: input.gitToken,
            buildingBlocks: input.buildingBlocks,
          }),
        ),
      );
    },

    updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
      return request<Project>(
        `/projects/${encodeURIComponent(id)}`,
        // PATCH, not PUT: a field that is not sent keeps its stored value, which
        // is how an untouched password field leaves the PAT alone.
        send('PATCH', withoutBlanks({ ...input })),
      );
    },

    removeProject(id: string): Promise<void> {
      return remove(`/projects/${encodeURIComponent(id)}`);
    },

    buildProject(id: string): Promise<Project> {
      // 202: the server took the request, the build happens afterwards.
      return request<Project>(`/projects/${encodeURIComponent(id)}/build`, { method: 'POST' });
    },

    projectBuildLog(id: string): Promise<BuildLog> {
      return request<BuildLog>(`/projects/${encodeURIComponent(id)}/build-log`);
    },
  };
}
