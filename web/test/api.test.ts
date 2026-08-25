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
  image: 'claudops-base',
  containerId: 'c1',
  projectId: 'proj1',
  repoUrl: null,
  repoBranch: null,
  createdAt: '2026-08-25T10:00:00.000Z',
  status: 'running',
};

const project = {
  id: 'proj1',
  name: 'claudops',
  repoUrl: 'https://example.test/repo.git',
  repoBranch: 'main',
  buildingBlocks: { dotnet: false, playwright: false },
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
});
