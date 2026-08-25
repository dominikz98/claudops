import type { FastifyInstance } from 'fastify';
import { createCipher, type SecretCipher } from '../src/secrets/cipher.ts';

/** A fixed key: these tests need a cipher that works, not a secret. */
export const TEST_SECRET_KEY = Buffer.alloc(32, 0x2a);

export function testCipher(): SecretCipher {
  return createCipher(TEST_SECRET_KEY);
}

export const TEST_REPO_URL = 'https://github.com/dominikz98/claudops.git';

/**
 * Creates the project an instance is made from, waits for its image, and returns
 * its id. Every test that starts an instance needs one: `POST /instances` takes
 * a `projectId` and nothing else about the repository, and it refuses a project
 * whose image is not `ready`.
 *
 * The wait is real polling rather than a hook into the builder. Builds are
 * asynchronous by design, and a test that pretends otherwise would stop
 * covering the state the API actually goes through.
 */
export async function createTestProject(
  app: FastifyInstance,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: { name: 'demo-project', repoUrl: TEST_REPO_URL, ...overrides },
  });

  const body = response.json<{ id?: string }>();
  if (body.id === undefined) {
    throw new Error(`could not create the test project: ${String(response.statusCode)} ${response.body}`);
  }

  await waitForImage(app, body.id);
  return body.id;
}

/** Polls until the project's image build has settled. Instant with the fake
 *  engine -- the loop is there to be independent of how many ticks it takes. */
export async function waitForImage(
  app: FastifyInstance,
  id: string,
  wanted: string = 'ready',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const project = (
      await app.inject({ method: 'GET', url: `/projects/${id}` })
    ).json<{ image?: { status?: string } }>();

    if (project.image?.status === wanted) return;
    // A macrotask, not a microtask: the build chain awaits the engine, so
    // yielding the microtask queue alone would spin.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`the image of project '${id}' never reached '${wanted}'`);
}
