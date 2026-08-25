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
  repoUrl: string | null;
  repoBranch: string | null;
  createdAt: string;
  /** Raw Docker state -- running, exited, created, ... -- or `missing`. */
  status: string;
}

export interface CreateInstanceInput {
  name: string;
  repoUrl?: string;
  repoBranch?: string;
  /** Passed straight through to the container. Never stored in the browser. */
  gitToken?: string;
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
 *  `minLength: 1` and would answer 400 for an empty string. */
function createBody(input: CreateInstanceInput): Record<string, string> {
  const body: Record<string, string> = { name: input.name };
  if (input.repoUrl) body.repoUrl = input.repoUrl;
  if (input.repoBranch) body.repoBranch = input.repoBranch;
  if (input.gitToken) body.gitToken = input.gitToken;
  return body;
}

export function createApi(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Api {
  return {
    async list(): Promise<Instance[]> {
      const response = await fetchImpl('/instances');
      if (!response.ok) throw await failure(response);
      const body = (await response.json()) as { instances: Instance[] };
      return body.instances;
    },

    async get(id: string): Promise<Instance> {
      const response = await fetchImpl(`/instances/${encodeURIComponent(id)}`);
      if (!response.ok) throw await failure(response);
      return (await response.json()) as Instance;
    },

    async create(input: CreateInstanceInput): Promise<Instance> {
      const response = await fetchImpl('/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody(input)),
      });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as Instance;
    },

    async remove(id: string): Promise<void> {
      const response = await fetchImpl(`/instances/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw await failure(response);
    },
  };
}
