/**
 * Issue #9, AC 2: the UI and the WebSocket endpoint are unusable without a
 * login.
 *
 * Everything here deliberately opts out of `use.storageState` -- a fresh context
 * with no cookie is the only way to see what an unauthenticated visitor sees.
 * The rest of the suite runs logged in, which is what proves the cookie works at
 * all.
 */

import { expect, test, type Browser } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const SECRET = process.env.CLAUDOPS_E2E_LOGIN_SECRET ?? '';

/** A context with an empty cookie jar, whatever `use.storageState` says. */
async function anonymous(browser: Browser): ReturnType<Browser['newContext']> {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

/** `use.baseURL` narrowed: the config always sets it, the fixture type does not
 *  say so, and `exactOptionalPropertyTypes` will not let it through undefined. */
function requireBaseUrl(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error('no baseURL configured');
  return baseURL;
}

test.describe('without a session', () => {
  test('the API refuses every endpoint but /health', async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL: requireBaseUrl(baseURL) });

    expect((await request.get('/instances')).status()).toBe(401);
    expect((await request.get('/projects')).status()).toBe(401);
    // The check itself is behind the gate, so its 401 *is* the answer.
    expect((await request.get('/session')).status()).toBe(401);
    // Leaks strictly less than a 404: without a session not even the route table
    // shows.
    expect((await request.get('/nope')).status()).toBe(401);

    const health = await request.get('/health');
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', docker: 'ok' });

    await request.dispose();
  });

  test('the SPA shell is served, because it is the login page', async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL: requireBaseUrl(baseURL) });

    // One index.html plus one hashed bundle, the same files the app is built
    // from. They carry no data -- every instance, project and console is behind
    // the gate.
    const shell = await request.get('/');
    expect(shell.status()).toBe(200);

    const asset = /src="([^"]+\.js)"/.exec(await shell.text())?.[1];
    expect(asset, 'index.html should reference a built module').toBeDefined();
    expect((await request.get(asset ?? '')).status()).toBe(200);

    await request.dispose();
  });

  test('the terminal upgrade is refused before the handler runs', async ({
    playwright,
    baseURL,
  }) => {
    // The gate answers the upgrade with a plain HTTP 401, so there is no socket
    // and no close code -- which is why this asserts a status rather than a 4401.
    const request = await playwright.request.newContext({ baseURL: requireBaseUrl(baseURL) });
    const response = await request.get('/instances/does-not-exist/terminal', {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });

    expect(response.status()).toBe(401);
    await request.dispose();
  });

  test('the browser lands on the login form and gets to the list from there', async ({
    browser,
  }) => {
    const context = await anonymous(browser);
    const page = await context.newPage();

    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    // The list is not merely hidden -- it was never mounted.
    await expect(page.getByTestId('instances')).toHaveCount(0);

    await page.getByTestId('secret').fill('not-the-shared-secret');
    await page.getByTestId('login').click();
    await expect(page.getByTestId('banner')).toContainText('Wrong secret');
    await expect(page.getByTestId('login-form')).toBeVisible();

    await page.getByTestId('secret').fill(SECRET);
    await page.getByTestId('login').click();
    await expect(page.getByTestId('instances')).toBeVisible();

    await context.close();
  });

  test('a reload keeps the session, and logging out ends it', async ({ browser }) => {
    const context = await anonymous(browser);
    const page = await context.newPage();

    await page.goto('/');
    await page.getByTestId('secret').fill(SECRET);
    await page.getByTestId('login').click();
    await expect(page.getByTestId('instances')).toBeVisible();

    // The cookie outlives the page, which is the whole point of not keeping the
    // session in memory.
    await page.reload();
    await expect(page.getByTestId('instances')).toBeVisible();

    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();

    // And it stays ended across a reload, rather than the form being a view the
    // browser can navigate away from.
    await page.reload();
    await expect(page.getByTestId('login-form')).toBeVisible();

    await context.close();
  });
});
