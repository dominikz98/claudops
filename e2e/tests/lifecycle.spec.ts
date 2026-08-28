/**
 * The acceptance criteria of issue #8 that a browser can see: an instance is
 * stopped and started again from the list instead of being thrown away, and a
 * delete leaves neither a container nor a volume behind.
 *
 * The limits are checked here as well, because `docker inspect` is where the
 * criterion says they have to be visible -- and this file has a real container
 * to inspect. The startup reconcile is not here: it needs the server to be
 * restarted, which Playwright owns, so it lives in server/smoke-test.sh.
 */

import { expect, test, type Page } from '@playwright/test';
import { containersFor, hostConfigOf, removeContainers, volumesFor } from '../docker.ts';
import { waitForImage } from '../project.ts';

test.describe.configure({ mode: 'serial' });

const PROJECT = 'e2e-lifecycle';

let page: Page;
let instanceId = '';
let containerId = '';

/** The list polls every three seconds, and `docker stop` gives the container
 *  ten to end on its own -- both are slower than Playwright's default wait. */
const STATE_TIMEOUT = 30_000;

const row = (): ReturnType<Page['locator']> =>
  page.locator(`tr[data-instance-id="${instanceId}"]`);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  if (instanceId !== '') removeContainers(instanceId);
  await page.close();
});

test('an instance starts with the configured CPU and memory ceiling', async () => {
  // Created through the API: this file is about what happens to an instance
  // afterwards, and instance.spec.ts already covers the create form.
  const project = await page.request.post('/projects', {
    data: { name: PROJECT, repoUrl: 'https://github.com/dominikz98/does-not-exist.git' },
  });
  expect(project.status(), await project.text()).toBe(201);
  const { id: projectId } = (await project.json()) as { id: string };
  await waitForImage(page.request, projectId);

  const created = await page.request.post('/instances', {
    data: { name: 'e2e-lifecycle', projectId },
  });
  expect(created.status(), await created.text()).toBe(201);
  ({ id: instanceId, containerId } = (await created.json()) as {
    id: string;
    containerId: string;
  });

  const limits = hostConfigOf(containerId);
  // The server's defaults: two CPUs and four gigabytes, in the units the API
  // takes them.
  expect(limits.NanoCpus).toBe(2_000_000_000);
  expect(limits.Memory).toBe(4 * 1024 * 1024 * 1024);
  // Swap capped at the memory limit means the container is killed rather than
  // paging the whole host.
  expect(limits.MemorySwap).toBe(limits.Memory);
});

test('AC: an instance can be stopped and started again from the list', async () => {
  await page.goto('/');
  await expect(row().getByTestId('status')).toHaveText('running');

  await row().getByTestId('stop').click();

  await expect(row().getByTestId('status')).toHaveText('exited', { timeout: STATE_TIMEOUT });
  // Stopped, not deleted: the container and everything in it is still there.
  expect(containersFor(instanceId)).toEqual([containerId.slice(0, 12)]);
  // #25 AC: no container, no session -- and no Console button to press.
  await expect(row().getByTestId('session')).toHaveCount(0);
  await expect(row().getByTestId('console')).toBeDisabled();

  await row().getByTestId('start').click();

  await expect(row().getByTestId('status')).toHaveText('running', { timeout: STATE_TIMEOUT });
  // A restart puts the healthcheck back to `starting`, so the console comes
  // back only once the entrypoint has built its session again -- a firewall and
  // a clone attempt further than the container state alone.
  await expect(row().getByTestId('session')).toHaveText('ready', { timeout: 60_000 });
  await expect(row().getByTestId('console')).toBeEnabled();
});

test('AC: after a delete no container and no volume of the instance remains', async () => {
  await row().getByTestId('delete').click();
  await row().getByTestId('confirm-delete').click();

  await expect(page.locator(`tr[data-instance-id="${instanceId}"]`)).toHaveCount(0);
  await expect.poll(() => containersFor(instanceId), { timeout: STATE_TIMEOUT }).toEqual([]);
  expect(volumesFor(instanceId)).toEqual([]);
});
