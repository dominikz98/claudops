import type { FastifyInstance } from 'fastify';
import { createCipher, type SecretCipher } from '../src/secrets/cipher.ts';

/** A fixed key: these tests need a cipher that works, not a secret. */
export const TEST_SECRET_KEY = Buffer.alloc(32, 0x2a);

export function testCipher(): SecretCipher {
  return createCipher(TEST_SECRET_KEY);
}

export const TEST_REPO_URL = 'https://github.com/dominikz98/claudops.git';

/**
 * Creates the project an instance is made from and returns its id. Every test
 * that starts an instance needs one, because `POST /instances` takes a
 * `projectId` and nothing else about the repository.
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
  return body.id;
}
