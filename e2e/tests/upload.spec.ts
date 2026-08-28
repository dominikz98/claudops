/**
 * Issue #15 in a browser: the three ways a file gets into an instance -- the
 * picker, a drop on the console, and a paste from the clipboard.
 *
 * Every claim is checked twice, like the other console specs: once in the page
 * and once inside the container. What cannot be checked here is the last hop of
 * AC 1 -- whether Claude then describes the image -- because these containers
 * run with a probe token. What this proves is that the bytes are in the
 * container and that their path is in the prompt.
 */

import { expect, test, type Page } from '@playwright/test';
import { capturePane, containersFor, readFile, removeContainers } from '../docker.ts';
import { waitForImage } from '../project.ts';

test.describe.configure({ mode: 'serial' });

const SESSION = 'main';
const UPLOADS = '/workspace/.claudops/uploads';
/** The same path as a pattern. A pasted image is named after the clock, so only
 *  the shape of its name can be asserted. */
const PASTED_PATH = String.raw`/workspace/\.claudops/uploads/pasted-\d{8}-\d{6}\.png`;

let page: Page;
let instanceId = '';
let containerId = '';

/** Dispatches an event carrying one file, the way a browser would deliver a
 *  drop or a paste. `DataTransfer` can only be built inside the page. */
async function deliver(
  kind: 'drop' | 'paste',
  name: string,
  type: string,
  text: string,
): Promise<void> {
  // An object rather than a tuple: a destructured array element is
  // `string | undefined` under noUncheckedIndexedAccess.
  await page.getByTestId('terminal').evaluate(
    (node, delivery) => {
      const data = new DataTransfer();
      data.items.add(new File([delivery.text], delivery.name, { type: delivery.type }));
      node.dispatchEvent(
        delivery.kind === 'drop'
          ? new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
          : new ClipboardEvent('paste', {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            }),
      );
    },
    { kind, name, type, text },
  );
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  if (instanceId !== '') removeContainers(instanceId);
  await page.close();
});

test('an instance with an attachable console', async () => {
  const project = await page.request.post('/projects', {
    data: { name: 'e2e-upload', repoUrl: 'https://github.com/dominikz98/does-not-exist.git' },
  });
  expect(project.status(), await project.text()).toBe(201);

  const { id } = (await project.json()) as { id: string };
  await waitForImage(page.request, id);

  await page.goto('/');
  await page.getByTestId('name').fill('e2e-upload');
  await page.getByTestId('projectId').selectOption({ label: 'e2e-upload' });
  await page.getByTestId('create-submit').click();

  const row = page.locator('tr[data-instance-id]').last();
  instanceId = (await row.getAttribute('data-instance-id')) ?? '';
  expect(instanceId).not.toBe('');
  [containerId = ''] = containersFor(instanceId);

  // The path is typed into tmux, so the session has to be up -- not just the
  // container.
  await expect(row.getByTestId('session')).toHaveText('ready', { timeout: 60_000 });
  await row.getByTestId('console').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-state', 'connected');
});

test('AC 2: a file from the picker is readable at the path the console shows', async () => {
  await page.getByTestId('attach-input').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('PICKED-BY-HAND'),
  });

  await expect(page.getByTestId('upload-status')).toHaveText(`attached ${UPLOADS}/notes.txt`);
  expect(readFile(containerId, `${UPLOADS}/notes.txt`)).toBe('PICKED-BY-HAND');

  // The path has to be in the prompt, not merely in the answer of a REST call.
  await expect
    .poll(() => capturePane(containerId, SESSION), { timeout: 15_000 })
    .toContain(`${UPLOADS}/notes.txt`);
  await expect(page.getByTestId('terminal')).toContainText(`${UPLOADS}/notes.txt`);
});

test('AC 2: a file dropped on the console arrives the same way', async () => {
  await deliver('drop', 'dropped.log', 'text/plain', 'DROPPED-ON-THE-CONSOLE');

  await expect(page.getByTestId('upload-status')).toHaveText(`attached ${UPLOADS}/dropped.log`);
  expect(readFile(containerId, `${UPLOADS}/dropped.log`)).toBe('DROPPED-ON-THE-CONSOLE');
});

test('AC 1: a pasted screenshot becomes a file with a name of its own', async () => {
  await deliver('paste', 'image.png', 'image/png', 'PASTED-FROM-THE-CLIPBOARD');

  // Not `image.png`: every clipboard image is called that, so a second paste
  // would overwrite the first. A retrying matcher rather than a bare read --
  // the upload is a round trip, and for the first moment after the event the
  // status line still says "uploading".
  const line = page.getByTestId('upload-status');
  await expect(line).toHaveText(new RegExp(`^attached ${PASTED_PATH}$`));

  const path = /\/workspace\S+/.exec((await line.textContent()) ?? '')?.[0] ?? '';
  expect(readFile(containerId, path)).toBe('PASTED-FROM-THE-CLIPBOARD');

  await expect.poll(() => capturePane(containerId, SESSION), { timeout: 15_000 }).toContain(path);
});

test('AC 4: a file over the limit is refused and the console says why', async () => {
  // playwright.config.ts starts this server with a 64 KiB ceiling, so 100 KiB
  // is over it without being slow to send.
  await page.getByTestId('attach-input').setInputFiles({
    name: 'too-big.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(100 * 1024, 0x41),
  });

  await expect(page.getByTestId('upload-status')).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('upload-status')).toContainText('upload_too_large');
  expect(() => readFile(containerId, `${UPLOADS}/too-big.bin`)).toThrow();

  // The refusal is not a crash: the console keeps working straight afterwards.
  await deliver('drop', 'after.txt', 'text/plain', 'STILL-WORKS');
  await expect(page.getByTestId('upload-status')).toHaveText(`attached ${UPLOADS}/after.txt`);
  expect(readFile(containerId, `${UPLOADS}/after.txt`)).toBe('STILL-WORKS');
});

test('a name that cannot be used is refused before anything is written', async () => {
  const response = await page.request.post(
    `/instances/${instanceId}/files?name=${encodeURIComponent('..')}`,
    { headers: { 'content-type': 'application/octet-stream' }, data: Buffer.from('x') },
  );

  expect(response.status()).toBe(400);
  expect((await response.json()) as { error: string }).toMatchObject({
    error: 'invalid_filename',
  });
});
