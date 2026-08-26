import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { request, type FullConfig } from '@playwright/test';

/**
 * Logs in once and writes the session cookie to `.tmp/auth.json`, which
 * `use.storageState` then hands to every context -- the `page` fixture and the
 * bare `request` fixture alike.
 *
 * A global setup rather than a `beforeAll` per file because the specs run
 * serially against one server and one Docker daemon: logging in once is the
 * honest model, and it keeps the login itself out of every other spec's setup.
 * `auth.spec.ts` is what proves an *unauthenticated* client gets nowhere, and it
 * builds its own context to do it.
 */

export const AUTH_FILE = resolve(import.meta.dirname, '.tmp/auth.json');

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (baseURL === undefined) throw new Error('no baseURL configured');

  const secret = process.env.CLAUDOPS_E2E_LOGIN_SECRET;
  if (secret === undefined || secret === '') {
    throw new Error('CLAUDOPS_E2E_LOGIN_SECRET is not set -- playwright.config.ts should default it');
  }

  const context = await request.newContext({ baseURL });
  const response = await context.post('/login', { data: { secret } });
  if (!response.ok()) {
    throw new Error(`login failed with ${String(response.status())}: ${await response.text()}`);
  }

  // run.sh removes .tmp before every run, so the directory may not exist yet.
  await mkdir(dirname(AUTH_FILE), { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(await context.storageState()));
  await context.dispose();
}
