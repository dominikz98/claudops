import { describe, expect, it } from 'vitest';
import { ApiCallError, createApi } from '../src/api.ts';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that records what it was asked and answers what the test says. */
function fakeFetch(answer: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(answer(call));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** The client only ever sends JSON strings; anything else is worth failing on
 *  rather than stringifying. */
function sentJson(call: Call | undefined): unknown {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string request body');
  return JSON.parse(body);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const instance = {
  id: 'abc123',
  name: 'demo',
  image: 'claudops-project-proj1',
  containerId: 'c1',
  projectId: 'proj1',
  repoUrl: null,
  repoBranch: null,
  createdAt: '2026-08-25T10:00:00.000Z',
  status: 'running',
  session: 'ready',
};

const project = {
  id: 'proj1',
  name: 'claudops',
  repoUrl: 'https://example.test/repo.git',
  repoBranch: 'main',
  buildingBlocks: { dotnet: false, playwright: false },
  image: { tag: 'claudops-project-proj1', status: 'ready', builtAt: '2026-08-25T10:05:00.000Z' },
  hasGitToken: true,
  instanceCount: 0,
  createdAt: '2026-08-25T10:00:00.000Z',
  updatedAt: '2026-08-25T10:00:00.000Z',
};

describe('api client', () => {
  it('unwraps the instances envelope', async () => {
    const { fetch, calls } = fakeFetch(() => json({ instances: [instance] }));

    expect(await createApi(fetch).list()).toEqual([instance]);
    expect(calls[0]?.url).toBe('/instances');
  });

  it('creates an instance from a project and sends nothing else', async () => {
    const { fetch, calls } = fakeFetch(() => json(instance, 201));

    await createApi(fetch).create({ name: 'demo', projectId: 'proj1' });

    expect(calls[0]?.url).toBe('/instances');
    expect(sentJson(calls[0])).toEqual({ name: 'demo', projectId: 'proj1' });
  });

  it('turns an error body into an ApiCallError', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: 'docker_unavailable', message: 'Docker Engine is unreachable' }, 503),
    );

    await expect(
      createApi(fetch).create({ name: 'demo', projectId: 'proj1' }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'docker_unavailable',
      message: 'Docker Engine is unreachable',
    });
  });

  it('survives an error answer that is not JSON', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>502</html>', { status: 502 }));

    const error = await createApi(fetch)
      .list()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiCallError);
    expect((error as ApiCallError).code).toBe('request_failed');
  });

  it('escapes the id in the path', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));

    await createApi(fetch).remove('a/b');

    expect(calls[0]?.url).toBe('/instances/a%2Fb');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  describe('stop and start', () => {
    it('posts to the instance and answers with its new state', async () => {
      const { fetch, calls } = fakeFetch(() => json({ ...instance, status: 'exited' }));

      expect((await createApi(fetch).stop('abc123')).status).toBe('exited');
      expect(calls[0]?.url).toBe('/instances/abc123/stop');
      expect(calls[0]?.init?.method).toBe('POST');
      // No body: what should happen is in the path.
      expect(calls[0]?.init?.body).toBeUndefined();
    });

    it('starts by the same route, with the id escaped', async () => {
      const { fetch, calls } = fakeFetch(() => json(instance));

      await createApi(fetch).start('a/b');

      expect(calls[0]?.url).toBe('/instances/a%2Fb/start');
    });

    it('turns a refused stop into an ApiCallError', async () => {
      const { fetch } = fakeFetch(() =>
        json({ error: 'container_missing', message: "instance 'abc123' has no container" }, 409),
      );

      await expect(createApi(fetch).stop('abc123')).rejects.toMatchObject({
        status: 409,
        code: 'container_missing',
      });
    });
  });

  describe('projects', () => {
    it('unwraps the projects envelope', async () => {
      const { fetch, calls } = fakeFetch(() => json({ projects: [project] }));

      expect(await createApi(fetch).listProjects()).toEqual([project]);
      expect(calls[0]?.url).toBe('/projects');
    });

    it('sends the blocks always and the optional fields only when filled in', async () => {
      const { fetch, calls } = fakeFetch(() => json(project, 201));

      await createApi(fetch).createProject({
        name: 'claudops',
        repoUrl: 'https://example.test/repo.git',
        repoBranch: '',
        gitToken: '',
        buildingBlocks: { dotnet: true, playwright: false },
      });

      expect(sentJson(calls[0])).toEqual({
        name: 'claudops',
        repoUrl: 'https://example.test/repo.git',
        buildingBlocks: { dotnet: true, playwright: false },
      });
    });

    it('patches only the fields it was given', async () => {
      const { fetch, calls } = fakeFetch(() => json(project));

      await createApi(fetch).updateProject('proj1', { name: 'renamed' });

      expect(calls[0]?.url).toBe('/projects/proj1');
      expect(calls[0]?.init?.method).toBe('PATCH');
      expect(sentJson(calls[0])).toEqual({ name: 'renamed' });
    });

    it('keeps an explicit null, because that is how a PAT is removed', async () => {
      const { fetch, calls } = fakeFetch(() => json(project));

      await createApi(fetch).updateProject('proj1', { gitToken: null, repoBranch: null });

      expect(sentJson(calls[0])).toEqual({ gitToken: null, repoBranch: null });
    });

    it('drops an untouched password field instead of clearing the PAT', async () => {
      const { fetch, calls } = fakeFetch(() => json(project));

      await createApi(fetch).updateProject('proj1', { gitToken: '', name: 'renamed' });

      expect(sentJson(calls[0])).toEqual({ name: 'renamed' });
    });

    it('deletes a project by its escaped id', async () => {
      const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));

      await createApi(fetch).removeProject('a/b');

      expect(calls[0]?.url).toBe('/projects/a%2Fb');
      expect(calls[0]?.init?.method).toBe('DELETE');
    });
  });

  describe('project images', () => {
    it('reads the image state off the project', async () => {
      const { fetch } = fakeFetch(() => json({ projects: [project] }));

      const [first] = await createApi(fetch).listProjects();

      expect(first?.image).toEqual({
        tag: 'claudops-project-proj1',
        status: 'ready',
        builtAt: '2026-08-25T10:05:00.000Z',
      });
    });

    it('asks for a rebuild with an empty POST', async () => {
      const { fetch, calls } = fakeFetch(() =>
        json({ ...project, image: { ...project.image, status: 'pending' } }, 202),
      );

      const rebuilt = await createApi(fetch).buildProject('a/b');

      expect(calls[0]?.url).toBe('/projects/a%2Fb/build');
      expect(calls[0]?.init?.method).toBe('POST');
      // No body: what to build is the project, and that is in the path.
      expect(calls[0]?.init?.body).toBeUndefined();
      expect(rebuilt.image.status).toBe('pending');
    });

    it('fetches the build log from its own endpoint', async () => {
      const { fetch, calls } = fakeFetch(() =>
        json({ status: 'failed', builtAt: null, log: 'Step 3/3 : RUN false' }),
      );

      const log = await createApi(fetch).projectBuildLog('proj1');

      expect(calls[0]?.url).toBe('/projects/proj1/build-log');
      expect(log).toEqual({ status: 'failed', builtAt: null, log: 'Step 3/3 : RUN false' });
    });

    it('turns a refused build into an ApiCallError', async () => {
      const { fetch } = fakeFetch(() => json({ error: 'not_found', message: 'no such route' }, 404));

      await expect(createApi(fetch).buildProject('nope')).rejects.toBeInstanceOf(ApiCallError);
    });
  });
});

describe('uploads', () => {
  const upload = {
    name: 'shot.png',
    path: '/workspace/.claudops/uploads/shot.png',
    size: 4,
    announced: true,
  };

  it('posts the bytes as the body and the name in the query', async () => {
    const { fetch, calls } = fakeFetch(() => json(upload, 201));

    await expect(createApi(fetch).upload('abc123', 'shot.png', new Blob(['data']))).resolves.toEqual(
      upload,
    );
    expect(calls[0]?.url).toBe('/instances/abc123/files?name=shot.png');
    expect(calls[0]?.init?.method).toBe('POST');
    // Not the blob's own type: the server has a parser for exactly this one.
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/octet-stream' });
    expect(calls[0]?.init?.body).toBeInstanceOf(Blob);
  });

  it('escapes a name that would otherwise change the query', async () => {
    const { fetch, calls } = fakeFetch(() => json(upload, 201));

    await createApi(fetch).upload('abc123', 'a b&c=d.png', new Blob(['x']));

    expect(calls[0]?.url).toBe('/instances/abc123/files?name=a%20b%26c%3Dd.png');
  });

  it('turns a refusal into an ApiCallError the console can print', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: 'upload_too_large', message: 'the file is 30.0 MiB' }, 413),
    );

    const error = await createApi(fetch)
      .upload('abc123', 'big.bin', new Blob(['x']))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiCallError);
    expect((error as ApiCallError).code).toBe('upload_too_large');
  });
});

describe('the login half of the API', () => {
  it('posts the secret and expects a cookie to be set by the server', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ authenticated: true, expiresAt: '2026-08-26T20:00:00.000Z' }),
    );

    await createApi(fetch).login('a-shared-secret-long-enough');

    expect(calls[0]?.url).toBe('/login');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(sentJson(calls[0])).toEqual({ secret: 'a-shared-secret-long-enough' });
  });

  it('turns a wrong secret into an ApiCallError with the code the form branches on', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: 'invalid_secret', message: 'that is not the shared secret' }, 401),
    );

    await expect(createApi(fetch).login('wrong')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_secret',
    });
  });

  it('posts the logout and tolerates its empty 204', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));

    await createApi(fetch).logout();

    expect(calls[0]?.url).toBe('/logout');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('reads the session state', async () => {
    const { fetch } = fakeFetch(() =>
      json({ authenticated: true, expiresAt: '2026-08-26T20:00:00.000Z' }),
    );

    await expect(createApi(fetch).session()).resolves.toEqual({
      authenticated: true,
      expiresAt: '2026-08-26T20:00:00.000Z',
    });
  });
});

describe('a lost session', () => {
  const gateRefusal = (): Response =>
    json({ error: 'unauthorized', message: 'log in first' }, 401);

  it('is reported once per refused call, whichever verb it was', async () => {
    let seen = 0;
    const { fetch } = fakeFetch(gateRefusal);
    const api = createApi(fetch, () => {
      seen += 1;
    });

    await expect(api.list()).rejects.toBeInstanceOf(ApiCallError);
    // DELETE has its own path through the client, so it needs its own proof.
    await expect(api.remove('abc123')).rejects.toBeInstanceOf(ApiCallError);

    expect(seen).toBe(2);
  });

  it('is not reported for a wrong secret at the form', async () => {
    // `invalid_secret` means "you were at the form and got it wrong" -- sending
    // the browser to the form again would throw that message away unread.
    let seen = 0;
    const { fetch } = fakeFetch(() =>
      json({ error: 'invalid_secret', message: 'that is not the shared secret' }, 401),
    );

    await expect(
      createApi(fetch, () => {
        seen += 1;
      }).login('wrong'),
    ).rejects.toBeInstanceOf(ApiCallError);
    expect(seen).toBe(0);
  });

  it('is not reported for an ordinary failure', async () => {
    let seen = 0;
    const { fetch } = fakeFetch(() => json({ error: 'not_found', message: 'no such route' }, 404));

    await expect(
      createApi(fetch, () => {
        seen += 1;
      }).get('nope'),
    ).rejects.toBeInstanceOf(ApiCallError);
    expect(seen).toBe(0);
  });
});
