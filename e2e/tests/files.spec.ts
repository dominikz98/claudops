/**
 * Issue #18 in a browser: what an instance produced, seen from the console
 * that produced it.
 *
 * The fixtures are written *into the container*, not committed and not
 * uploaded, because that is the claim: a screenshot Claude took and a report it
 * wrote are visible without a `git add`. The one exception is the pasted
 * screenshot, which goes the whole way through the upload of #15 -- that is the
 * loop an operator actually runs.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  containersFor,
  makeSymlink,
  removeContainers,
  writeFile,
  writeSparseFile,
} from '../docker.ts';
import { waitForImage } from '../project.ts';

test.describe.configure({ mode: 'serial' });

const REPO = '/workspace/repo';
/** A report with everything the panel has to render, and one thing it must
 *  not: the file comes out of a container, so its markup stays text. */
const REPORT = [
  '# Run report',
  '',
  'The suite is **green**.',
  '',
  '- 476 server tests',
  '- 71 web tests',
  '',
  '[the PR](https://github.com/dominikz98/claudops/pull/1)',
  '',
  '```sh',
  'pnpm test',
  '```',
  '',
  "<script>window.pwned = true</script>",
  '',
].join('\n');

/** A real 1x1 PNG. Text with a `.png` name would prove nothing: the point is
 *  that bytes survive the tar and the HTTP body. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let page: Page;
let instanceId = '';
let containerId = '';

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  if (instanceId !== '') removeContainers(instanceId);
  await page.close();
});

test('an instance with something in its workspace', async () => {
  const project = await page.request.post('/projects', {
    data: { name: 'e2e-files', repoUrl: 'https://github.com/dominikz98/does-not-exist.git' },
  });
  expect(project.status(), await project.text()).toBe(201);

  const { id } = (await project.json()) as { id: string };
  await waitForImage(page.request, id);

  await page.goto('/');
  await page.getByTestId('name').fill('e2e-files');
  await page.getByTestId('projectId').selectOption({ label: 'e2e-files' });
  await page.getByTestId('create-submit').click();

  const row = page.locator('tr[data-instance-id]').last();
  instanceId = (await row.getAttribute('data-instance-id')) ?? '';
  expect(instanceId).not.toBe('');
  [containerId = ''] = containersFor(instanceId);

  // The panel only needs a running container, not an attachable session -- but
  // the upload below types into tmux, so wait for the session anyway.
  await expect(row.getByTestId('session')).toHaveText('ready', { timeout: 60_000 });

  // What a run leaves behind. Written in the container, never committed.
  writeFile(containerId, `${REPO}/REPORT.md`, REPORT);
  writeFile(containerId, `${REPO}/src/main.ts`, 'export const x = 1;\n');
  // playwright.config.ts caps a read at 256 KiB, so half a megabyte is over it
  // without being slow to create.
  writeSparseFile(containerId, `${REPO}/heap.bin`, 512 * 1024);
  makeSymlink(containerId, '/etc/passwd', '/workspace/escape.txt');
  makeSymlink(containerId, '/etc', '/workspace/outside');

  await row.getByTestId('console').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-state', 'connected');
});

test('the panel opens next to the console and lists the workspace', async () => {
  await expect(page.getByTestId('files-panel')).toHaveCount(0);
  await page.getByTestId('files-toggle').click();

  await expect(page.getByTestId('files-panel')).toBeVisible();
  // The console is still there: the panel takes width from it, it does not
  // replace it.
  await expect(page.getByTestId('terminal')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveAttribute('data-state', 'connected');

  await expect(page.locator('[data-path="/workspace/repo"]')).toBeVisible();
  // A symlink is listed and cannot be opened -- what it points at is decided
  // in the container, not by the name.
  await expect(page.locator('[data-path="/workspace/escape.txt"]')).toBeDisabled();
});

test('AC 2: a .md file Claude wrote renders as Markdown', async () => {
  await page.locator('[data-path="/workspace/repo"]').click();
  await page.locator(`[data-path="${REPO}/REPORT.md"]`).click();

  const rendered = page.getByTestId('preview-markdown');
  await expect(rendered.locator('h1')).toHaveText('Run report');
  await expect(rendered.locator('strong')).toHaveText('green');
  await expect(rendered.locator('li')).toHaveCount(2);
  await expect(rendered.locator('pre code')).toHaveText('pnpm test');
  await expect(rendered.locator('a')).toHaveAttribute(
    'href',
    'https://github.com/dominikz98/claudops/pull/1',
  );

  // The file came out of a container, so its markup is text. Both halves
  // matter: no element, and the source still readable.
  await expect(rendered.locator('script')).toHaveCount(0);
  await expect(rendered).toContainText('<script>window.pwned = true</script>');
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false);
});

test('AC 1: a screenshot is visible in the browser without having been committed', async () => {
  // Through the upload of #15, which is how a screenshot really gets there.
  await page.getByTestId('attach-input').setInputFiles({
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByTestId('upload-status')).toHaveAttribute('data-state', 'done');

  await page.locator('[data-path="/workspace/.claudops"]').click();
  await page.locator('[data-path="/workspace/.claudops/uploads"]').click();
  await page.locator('[data-path="/workspace/.claudops/uploads/screenshot.png"]').click();

  const image = page.getByTestId('preview-image');
  await expect(image).toBeVisible();
  // Decoded by the browser: an `<img>` that is there but broken would pass a
  // visibility check and prove nothing.
  await expect
    .poll(async () =>
      image.evaluate((node: HTMLImageElement) => [
        node.complete,
        node.naturalWidth,
        node.naturalHeight,
      ]),
    )
    .toEqual([true, 1, 1]);

  // Nothing was committed and nothing was downloaded: the bytes came from the
  // instance through the API.
  expect(await image.getAttribute('src')).toMatch(/^blob:/);
});

test('AC 4: a file over the limit returns an error instead of being read', async () => {
  await page.locator(`[data-path="${REPO}/heap.bin"]`).click();

  const message = page.getByTestId('preview-message');
  await expect(message).toHaveAttribute('data-state', 'error');
  await expect(message).toContainText('file_too_large');
  // No Save as either: the download goes through the same endpoint and the
  // same limit.
  await expect(page.getByTestId('preview-download')).toBeHidden();

  // The refusal is not a crash: the panel keeps working straight afterwards.
  await page.locator(`[data-path="${REPO}/REPORT.md"]`).click();
  await expect(page.getByTestId('preview-markdown').locator('h1')).toHaveText('Run report');
});

test('AC 3: a path outside the workspace is rejected', async () => {
  for (const path of ['../../etc/passwd', '/etc/passwd', '/workspace/../etc/passwd']) {
    const response = await page.request.get(
      `/instances/${instanceId}/files/content?path=${encodeURIComponent(path)}`,
    );
    expect(response.status(), path).toBe(400);
    expect((await response.json()) as { error: string }, path).toMatchObject({
      error: 'path_outside_workspace',
    });
    expect(await response.text(), path).not.toContain('root:x:');
  }

  for (const path of ['/etc', '../../root']) {
    const response = await page.request.get(
      `/instances/${instanceId}/files?path=${encodeURIComponent(path)}`,
    );
    expect(response.status(), path).toBe(400);
  }
});

test('AC 3: a symlink out of the workspace is rejected too', async () => {
  // The one the server cannot decide on the string it was sent: the path is
  // inside the workspace and what it points at is not. Only the container
  // knows, which is why it resolves it a second time.
  const read = await page.request.get(
    `/instances/${instanceId}/files/content?path=${encodeURIComponent('/workspace/escape.txt')}`,
  );
  expect(read.status()).toBe(400);
  expect(await read.text()).not.toContain('root:x:');

  const through = await page.request.get(
    `/instances/${instanceId}/files?path=${encodeURIComponent('/workspace/outside')}`,
  );
  expect(through.status()).toBe(400);
  expect((await through.json()) as { error: string }).toMatchObject({
    error: 'path_outside_workspace',
  });
});

test('a file is downloadable as itself', async () => {
  const response = await page.request.get(
    `/instances/${instanceId}/files/content?path=${encodeURIComponent(`${REPO}/REPORT.md`)}&download=1`,
  );

  expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toContain('attachment');
  // Never text/html, whatever the file is called: it is served from claudops'
  // own origin, to a browser carrying the session cookie.
  expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(await response.text()).toBe(REPORT);
});

test('closing the panel gives the console its width back', async () => {
  const wide = await page.getByTestId('terminal').boundingBox();
  await page.getByTestId('files-toggle').click();

  await expect(page.getByTestId('files-panel')).toHaveCount(0);
  await expect
    .poll(async () => (await page.getByTestId('terminal').boundingBox())?.width ?? 0)
    .toBeGreaterThan(wide?.width ?? 0);
  await expect(page.getByTestId('status')).toHaveAttribute('data-state', 'connected');
});
