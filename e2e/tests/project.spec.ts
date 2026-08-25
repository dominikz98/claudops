/**
 * The acceptance criteria of issue #6, in the order a person would try them:
 * create a project with a PAT, create an instance from it, check that the
 * container really got the repository and the token, and that the project
 * refuses to disappear while an instance still points at it.
 *
 * One browser page for the whole file, like the console spec: these steps build
 * on each other on purpose.
 */

import { expect, test, type Page } from '@playwright/test';
import { containerEnv, containersFor, removeContainers } from '../docker.ts';

test.describe.configure({ mode: 'serial' });

const PROJECT = 'e2e-project';
const REPO = 'https://github.com/dominikz98/private-e2e.git';
const BRANCH = 'feature/dz/6';
/** Never a real token: the point is that it turns up in exactly one place. */
const PAT = 'e2e-pat-must-not-appear';

let page: Page;
let instanceId = '';
let containerId = '';

const row = (): ReturnType<Page['locator']> => page.locator('tr[data-project-id]');

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  if (instanceId !== '') removeContainers(instanceId);
  await page.close();
});

test('a project can be created from the browser', async () => {
  await page.goto('/#/projects');

  await page.getByTestId('project-name').fill(PROJECT);
  await page.getByTestId('project-repoUrl').fill(REPO);
  await page.getByTestId('project-repoBranch').fill(BRANCH);
  await page.getByTestId('project-gitToken').fill(PAT);
  await page.getByTestId('block-dotnet').check();
  await page.getByTestId('project-submit').click();

  const created = row().filter({ hasText: PROJECT });
  await expect(created).toHaveCount(1);
  await expect(created.getByTestId('project-token')).toHaveText('stored');
  await expect(created.getByTestId('project-instances')).toHaveText('0');
  await expect(created).toContainText('dotnet');
  await expect(created).toContainText(BRANCH);

  // The form is emptied, so the PAT does not sit in the DOM afterwards.
  await expect(page.getByTestId('project-gitToken')).toHaveValue('');
  expect(await page.content()).not.toContain(PAT);
});

test('AC 2: the PAT appears in no API response', async () => {
  const list = await page.request.get('/projects');
  const body = await list.text();

  expect(body).not.toContain(PAT);
  // Looked up by name rather than by position: the console spec leaves a
  // project of its own behind, and this assertion is about ours.
  const { projects } = JSON.parse(body) as { projects: { name: string }[] };
  expect(projects.find((project) => project.name === PROJECT)).toMatchObject({
    hasGitToken: true,
    buildingBlocks: { dotnet: true, playwright: false },
    repoUrl: REPO,
    repoBranch: BRANCH,
  });
});

test('AC 1: an instance created from the project gets its repo, branch and PAT', async () => {
  await page.getByTestId('back').click();

  await page.getByTestId('name').fill('e2e-from-project');
  await page.getByTestId('projectId').selectOption({ label: PROJECT });
  await page.getByTestId('create-submit').click();

  const instance = page.locator('tr[data-instance-id]').filter({ hasText: 'e2e-from-project' });
  await expect(instance).toHaveCount(1);
  await expect(instance.getByTestId('project')).toHaveText(PROJECT);
  // The repository is shown as the container was told it, not as a live view.
  await expect(instance).toContainText(REPO);

  instanceId = (await instance.getAttribute('data-instance-id')) ?? '';
  expect(instanceId).not.toBe('');
  [containerId = ''] = containersFor(instanceId);
  expect(containerId, 'the instance should have a labelled container').not.toBe('');

  // The part only the container can confirm: the decrypted PAT and the
  // repository of the project arrived as environment variables.
  const env = containerEnv(containerId);
  expect(env).toContain(`REPO_URL=${REPO}`);
  expect(env).toContain(`REPO_BRANCH=${BRANCH}`);
  expect(env).toContain(`GIT_TOKEN=${PAT}`);
  expect(env.filter((line) => line.startsWith('ANTHROPIC_API_KEY='))).toEqual([]);
});

test('AC 3: the project cannot be deleted while an instance points at it', async () => {
  await page.getByTestId('projects-link').click();

  const created = row().filter({ hasText: PROJECT });
  await expect(created.getByTestId('project-instances')).toHaveText('1');

  await created.getByTestId('delete').click();
  await created.getByTestId('confirm-delete').click();

  await expect(page.getByTestId('banner')).toContainText('project_in_use');
  await expect(page.getByTestId('banner')).toContainText('1 instance');
  await expect(row().filter({ hasText: PROJECT })).toHaveCount(1);
});

test('a project can be edited and its token removed', async () => {
  const created = row().filter({ hasText: PROJECT });
  await created.getByTestId('edit').click();

  // The stored PAT is not filled back in -- the server never sends it.
  await expect(page.getByTestId('project-gitToken')).toHaveValue('');
  await expect(page.getByTestId('token-hint')).toContainText('A token is stored');
  await expect(page.getByTestId('block-dotnet')).toBeChecked();

  await page.getByTestId('project-remove-token').click();

  await expect(row().filter({ hasText: PROJECT }).getByTestId('project-token')).toHaveText('--');
  expect(await (await page.request.get('/projects')).text()).not.toContain(PAT);
});

test('AC 3: with the instance gone the project can be deleted', async () => {
  await page.getByTestId('back').click();

  const instance = page.locator(`tr[data-instance-id="${instanceId}"]`);
  await instance.getByTestId('delete').click();
  await instance.getByTestId('confirm-delete').click();
  await expect(page.locator(`tr[data-instance-id="${instanceId}"]`)).toHaveCount(0);

  await page.getByTestId('projects-link').click();
  const created = row().filter({ hasText: PROJECT });
  await created.getByTestId('delete').click();
  await created.getByTestId('confirm-delete').click();

  await expect(row().filter({ hasText: PROJECT })).toHaveCount(0);
  await expect.poll(() => containersFor(instanceId), { timeout: 15_000 }).toEqual([]);
});
