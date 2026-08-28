/**
 * The REST half of the server, typed. The terminal half is a WebSocket and
 * lives in `terminal/session.ts`.
 *
 * `fetch` is a parameter rather than a global so the tests can drive this
 * without a browser and without a server.
 */

/**
 * Whether an instance's console can be attached to -- a second axis next to the
 * Docker status, because a container is `running` minutes before its tmux
 * session exists. Reported by the container's own healthcheck.
 *
 * `SessionReadiness` in server/src/instances/service.ts.
 */
export type SessionReadiness = 'none' | 'starting' | 'ready' | 'failed';

/**
 * Model aliases and effort levels an instance can run at.
 *
 * `INSTANCE_MODELS` / `INSTANCE_EFFORTS` in server/src/instances/service.ts,
 * which is where the reasoning behind them is. Mirrored rather than fetched:
 * four strings each, and the server's schema is what actually enforces them.
 * The absence of a choice is `null`, not a member of either list.
 */
export const INSTANCE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export const INSTANCE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** What Claude Code runs as. `null` is Claude Code's own default. */
export interface ModelChoice {
  model: string | null;
  effort: string | null;
}

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
  /** What Claude Code was started as, and what it has been switched to since.
   *  `null` means Claude Code's own default. */
  model: string | null;
  effort: string | null;
  createdAt: string;
  /** Raw Docker state -- running, exited, created, ... -- or `missing`. */
  status: string;
  /** Whether the console is attachable. `running` alone is not enough. */
  session: SessionReadiness;
}

export interface CreateInstanceInput {
  name: string;
  /** Repository, branch and PAT all come from the project. */
  projectId: string;
  /** Left out, the instance runs whatever Claude Code defaults to. */
  model?: string | null;
  effort?: string | null;
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

/** `UploadView` in server/src/instances/service.ts -- one file that made it
 *  into an instance. */
export interface Upload {
  /** What the server settled on. A name it had to sanitise comes back changed. */
  name: string;
  /** The absolute path inside the container: what Claude is told. */
  path: string;
  size: number;
  /** Whether the path was typed into the tmux session. `false` means the file
   *  is there but nothing put it in the prompt -- a session that is not up. */
  announced: boolean;
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

/** `GET /session`. A 401 rather than `authenticated: false` is the negative
 *  answer -- the endpoint sits behind the same gate as everything else. */
export interface SessionState {
  authenticated: boolean;
  expiresAt: string | null;
}

export interface Api {
  /** Exchanges the shared secret for a session cookie. Throws ApiCallError with
   *  `invalid_secret` for a wrong one and `too_many_attempts` for too many. */
  login(secret: string): Promise<void>;
  /** Clears the cookie. The token stays valid until it expires -- there is no
   *  store to revoke it in. */
  logout(): Promise<void>;
  /** Resolves when there is a session, throws a 401 ApiCallError when not. */
  session(): Promise<SessionState>;
  list(): Promise<Instance[]>;
  get(id: string): Promise<Instance>;
  create(input: CreateInstanceInput): Promise<Instance>;
  remove(id: string): Promise<void>;
  /** Stops the container and keeps the instance. Answers with the status
   *  Docker reports afterwards. */
  stop(id: string): Promise<Instance>;
  start(id: string): Promise<Instance>;
  /**
   * Switches model, effort, or both on a running instance. A field left out
   * keeps its stored value.
   *
   * Needs an attachable session: the server types the change into it as slash
   * commands, and answers `session_not_ready` or `container_missing` when there
   * is nothing to type into.
   */
  setModelEffort(id: string, changes: Partial<ModelChoice>): Promise<Instance>;
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(id: string, input: UpdateProjectInput): Promise<Project>;
  removeProject(id: string): Promise<void>;
  /** Asks for a rebuild. Answers before the build has run -- watch
   *  `image.status`. */
  buildProject(id: string): Promise<Project>;
  projectBuildLog(id: string): Promise<BuildLog>;
  /** Puts one file into the instance's uploads directory and lets the server
   *  write its path into the console. One file per call. */
  upload(id: string, name: string, content: Blob): Promise<Upload>;
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

/**
 * `onUnauthorized` is called for every refusal that came from the session gate.
 * That is the `unauthorized` code specifically, not `invalid_secret`: the first
 * means "your session is gone, go to the form", the second means "you were at
 * the form and got it wrong" -- and redirecting on the second would throw the
 * message away before anybody read it.
 *
 * Without it an expired session would show up as a red banner that the list
 * view's three-second poll repaints forever.
 */
export function createApi(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  onUnauthorized?: () => void,
): Api {
  /** Every refusal becomes an ApiCallError in exactly one place, which is also
   *  the one place that notices a lost session. */
  const fail = async (response: Response): Promise<ApiCallError> => {
    const error = await failure(response);
    if (error.code === 'unauthorized') onUnauthorized?.();
    return error;
  };

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(path, init);
    if (!response.ok) throw await fail(response);
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
    if (!response.ok) throw await fail(response);
  };

  return {
    async login(secret: string): Promise<void> {
      await request<{ authenticated: boolean }>('/login', send('POST', { secret }));
    },

    async logout(): Promise<void> {
      // 204 with no body, like a DELETE.
      const response = await fetchImpl('/logout', { method: 'POST' });
      if (!response.ok) throw await fail(response);
    },

    session(): Promise<SessionState> {
      return request<SessionState>('/session');
    },

    async list(): Promise<Instance[]> {
      return (await request<{ instances: Instance[] }>('/instances')).instances;
    },

    get(id: string): Promise<Instance> {
      return request<Instance>(`/instances/${encodeURIComponent(id)}`);
    },

    create(input: CreateInstanceInput): Promise<Instance> {
      return request<Instance>(
        '/instances',
        // withoutBlanks, so an unchosen model is left out rather than sent as
        // an empty string the enum would reject.
        send(
          'POST',
          withoutBlanks({
            name: input.name,
            projectId: input.projectId,
            model: input.model,
            effort: input.effort,
          }),
        ),
      );
    },

    setModelEffort(id: string, changes: Partial<ModelChoice>): Promise<Instance> {
      // No withoutBlanks here: `null` is the reset and has to travel.
      return request<Instance>(`/instances/${encodeURIComponent(id)}`, send('PATCH', { ...changes }));
    },

    remove(id: string): Promise<void> {
      return remove(`/instances/${encodeURIComponent(id)}`);
    },

    stop(id: string): Promise<Instance> {
      return request<Instance>(`/instances/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    },

    start(id: string): Promise<Instance> {
      return request<Instance>(`/instances/${encodeURIComponent(id)}/start`, { method: 'POST' });
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

    upload(id: string, name: string, content: Blob): Promise<Upload> {
      return request<Upload>(
        `/instances/${encodeURIComponent(id)}/files?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          // Deliberately not the blob's own type: the body is the bytes and
          // nothing else, the name travels in the query, and the server has a
          // parser for exactly this one content type.
          headers: { 'content-type': 'application/octet-stream' },
          body: content,
        },
      );
    },
  };
}
