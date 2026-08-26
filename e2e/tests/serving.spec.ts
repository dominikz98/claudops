/**
 * SPA and API share one port. What is worth asserting is that they do not
 * shadow each other -- the SPA is a wildcard route and the API is not.
 *
 * Every request here carries the session cookie from `use.storageState`, so what
 * these cases check is the routing, not the gate. `auth.spec.ts` is the one that
 * takes the cookie away again.
 */

import { expect, test } from '@playwright/test';

test('serves the SPA at the root', async ({ request }) => {
  const response = await request.get('/');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/html');
  expect(await response.text()).toContain('id="app"');
});

test('serves the hashed assets the page asks for', async ({ request }) => {
  const asset = /src="([^"]+\.js)"/.exec(await (await request.get('/')).text())?.[1];
  expect(asset, 'index.html should reference a built module').toBeDefined();

  const response = await request.get(asset ?? '');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('javascript');
});

test('leaves the authenticated API in its own namespace', async ({ request }) => {
  const instances = await request.get('/instances');
  expect(instances.status()).toBe(200);
  expect(await instances.json()).toHaveProperty('instances');

  const health = await request.get('/health');
  expect(await health.json()).toEqual({ status: 'ok', docker: 'ok' });
});

test('still answers an unknown path with the JSON 404', async ({ request }) => {
  const response = await request.get('/nope');

  expect(response.status()).toBe(404);
  expect(await response.json()).toMatchObject({ error: 'not_found' });
});
