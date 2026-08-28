/**
 * The three acceptance criteria of issue #5, in the order a person would try
 * them: create an instance, drive its console, reload the page, delete it.
 *
 * One browser page for the whole file -- AC 2 is about reloading *this* page,
 * so a fresh context per test would test something else.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  capturePane,
  containersFor,
  hasSession,
  listClients,
  openProbeWindow,
  paneSize,
  removeContainers,
} from '../docker.ts';
import { waitForImage } from '../project.ts';

test.describe.configure({ mode: 'serial' });

const SESSION = 'main';
/** The deterministic window `openProbeWindow` creates. */
const PROBE = `${SESSION}:probe`;

let page: Page;
let instanceId = '';
let containerId = '';

/** `connected · 148×39` -> [148, 39]. */
function geometry(status: string | null): [number, number] {
  const match = /(\d+)×(\d+)/.exec(status ?? '');
  expect(match, `no geometry in status line '${status ?? ''}'`).not.toBeNull();
  return [Number(match?.[1]), Number(match?.[2])];
}

async function type(line: string): Promise<void> {
  await page.getByTestId('terminal').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  // A failed run must not leave a container behind for the next one.
  if (instanceId !== '') removeContainers(instanceId);
  await page.close();
});

test('an instance can be created from the browser', async () => {
  // An instance is created from a project (#6). This one carries no PAT, so
  // everything below stays independent of any credential -- the clone fails and
  // the container keeps running, which is the documented behaviour
  // (knowledge/failed-clone-must-not-abort.md).
  const project = await page.request.post('/projects', {
    data: { name: 'e2e-console', repoUrl: 'https://github.com/dominikz98/does-not-exist.git' },
  });
  expect(project.status(), await project.text()).toBe(201);

  // An instance starts from its project's image, so it cannot be created before
  // that image exists -- the server answers 422 until it does.
  const { id } = (await project.json()) as { id: string };
  await waitForImage(page.request, id);

  await page.goto('/');
  await expect(page.getByTestId('empty')).toBeVisible();

  await page.getByTestId('name').fill('e2e');
  await page.getByTestId('projectId').selectOption({ label: 'e2e-console' });
  await page.getByTestId('create-submit').click();

  const row = page.locator('tr[data-instance-id]');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('status')).toHaveText('running');
  // #25 AC: the container is up, its session is not -- the entrypoint has a
  // firewall to install and a repository to clone first, and the healthcheck
  // has not run once yet. The Console button follows that, not the container.
  await expect(row.getByTestId('session')).toHaveText('starting');
  await expect(row.getByTestId('console')).toBeDisabled();

  instanceId = (await row.getAttribute('data-instance-id')) ?? '';
  expect(instanceId).not.toBe('');
  [containerId = ''] = containersFor(instanceId);
  expect(containerId, 'the instance should have a labelled container').not.toBe('');
});

test('AC 1: the console can be driven from the browser', async () => {
  const row = page.locator('tr[data-instance-id]');

  // #25 AC: waiting for the badge rather than for tmux -- that the two agree is
  // the point. The container reports its session through its healthcheck, and
  // the button is enabled by that and nothing else.
  await expect(row.getByTestId('session')).toHaveText('ready', { timeout: 60_000 });
  await expect(row.getByTestId('console')).toBeEnabled();
  expect(hasSession(containerId, SESSION)).toBe(true);

  openProbeWindow(containerId, SESSION);

  await row.getByTestId('console').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-state', 'connected');

  // The geometry has to survive browser -> query string -> exec -> tmux. 80x24
  // is Docker's default and would mean it did not.
  const [cols, rows] = geometry(await page.getByTestId('status').textContent());
  expect(cols).toBeGreaterThan(80);
  await expect.poll(() => paneSize(containerId, PROBE)).toBe(`${String(cols)}x${String(rows)}`);

  // Echoed keystrokes alone would already contain the command, so the marker is
  // built by the shell: only a command that really ran prints MARK-ALPHA.
  await type(String.raw`printf 'MARK-%s\n' ALPHA`);

  await expect
    .poll(() => capturePane(containerId, PROBE), { timeout: 15_000 })
    .toContain('MARK-ALPHA');
  await expect(page.getByTestId('terminal')).toContainText('MARK-ALPHA');

  // Anything above U+007F is the interesting case: tmux replaces it with an
  // underscore for a client that has not declared UTF-8, which turns Claude's
  // whole TUI into rows of "_" (knowledge/tmux-needs-a-utf8-client.md). The
  // escapes are resolved by the shell in the container, so only ASCII is typed
  // and the multi-byte bytes really do originate on the far side.
  await type(String.raw`printf 'BOX-\u250c\u2500\u2510\u2714-%s@' DONE; echo`);
  await expect(page.getByTestId('terminal')).toContainText('BOX-\u250c\u2500\u2510\u2714-DONE@');
});

test('AC 2: a browser refresh reconnects with the session intact', async () => {
  await type('sleep 987 &');
  await expect.poll(() => capturePane(containerId, PROBE), { timeout: 15_000 }).toContain('[1]');

  await page.reload();

  await expect(page.getByTestId('status')).toHaveAttribute('data-state', 'connected');
  // Nothing was replayed by the server: this is tmux redrawing its pane for a
  // new client (knowledge/terminal-streaming-via-tmux.md).
  await expect(page.getByTestId('terminal')).toContainText('MARK-ALPHA');

  await type('jobs');
  await expect(page.getByTestId('terminal')).toContainText('sleep 987');

  // The old tab's exec has to be gone, or tmux keeps sizing the pane for a
  // client nobody is watching (knowledge/docker-cannot-kill-an-exec.md).
  await expect.poll(() => listClients(containerId, SESSION).length, { timeout: 15_000 }).toBe(1);
});

test('AC 3: deleting from the UI removes the row and the container', async () => {
  await page.getByTestId('back').click();

  const row = page.locator(`tr[data-instance-id="${instanceId}"]`);
  await row.getByTestId('delete').click();
  await row.getByTestId('confirm-delete').click();

  await expect(page.locator('tr[data-instance-id]')).toHaveCount(0);
  await expect(page.getByTestId('empty')).toBeVisible();
  await expect.poll(() => containersFor(instanceId), { timeout: 15_000 }).toEqual([]);
});

test('a console for an instance that is gone says so instead of hanging', async () => {
  await page.goto('/#/i/does-not-exist');

  await expect(page.getByTestId('status')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.getByTestId('status')).toContainText('no such instance');
  await expect(page.getByTestId('reconnect')).toBeVisible();
});
