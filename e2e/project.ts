/**
 * The one thing every spec here has to do before it can start an instance: wait
 * for the project's image.
 *
 * Builds are asynchronous -- `POST /projects` answers `pending` and the image
 * appears seconds later -- and `POST /instances` refuses until it is `ready`.
 * With the e2e build context that wait is short; against the real template it
 * would be minutes.
 */

import { expect, type APIRequestContext } from '@playwright/test';

export type ImageStatus = 'pending' | 'building' | 'ready' | 'failed';

interface ProjectBody {
  id: string;
  image: { tag: string; status: ImageStatus; builtAt: string | null };
}

export async function projectOf(request: APIRequestContext, id: string): Promise<ProjectBody> {
  const response = await request.get(`/projects/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ProjectBody;
}

/** Polls until the project's image reaches `wanted`. Fails the test rather than
 *  letting the next step run into a 422 nobody expected. */
export async function waitForImage(
  request: APIRequestContext,
  id: string,
  wanted: ImageStatus = 'ready',
  timeout = 60_000,
): Promise<void> {
  await expect
    .poll(async () => (await projectOf(request, id)).image.status, { timeout })
    .toBe(wanted);
}

interface BuildLog {
  status: ImageStatus;
  builtAt: string | null;
  log: string;
}

export async function buildLogOf(request: APIRequestContext, id: string): Promise<BuildLog> {
  const response = await request.get(`/projects/${id}/build-log`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as BuildLog;
}
