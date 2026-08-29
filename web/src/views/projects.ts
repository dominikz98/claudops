/**
 * Projects: the templates instances are created from -- repository, branch,
 * environment building blocks and the PAT for a private repository.
 *
 * Mostly unpolled, unlike the instance list: a project changes when somebody on
 * this page changes it, and a poll would fight the form for the fields being
 * typed into. The exception is a running image build -- that one is the server
 * changing the project, so the page refreshes while any build is in flight and
 * stops again once they are all done. An open build log is re-read on the same
 * beat, because the server writes it away as the build produces it.
 *
 * The PAT is write-only: the server answers with `hasGitToken` and never with
 * the value, so this page can show that one is stored but never what it is. The
 * same holds for the project's environment variables -- the server answers with
 * their names, so they are listed and removable here, but never shown.
 */

import {
  ApiCallError,
  type Api,
  type BuildingBlocks,
  type ImageStatus,
  type Project,
} from '../api.ts';
import { clear, el } from '../dom.ts';
import { routeHash } from '../router.ts';
import type { View } from './view.ts';

/** How often the list is re-read while an image is being built. Slower than the
 *  instance list: a build takes minutes, not seconds. */
const BUILD_POLL_MS = 2000;

function describe(error: unknown): string {
  if (error instanceof ApiCallError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** What the badge says. `pending` is a build that has been asked for but has
 *  not started, which reads the same way from here. */
function imageLabel(status: ImageStatus): string {
  return status === 'pending' ? 'queued' : status;
}

/** Both states mean "the server is going to change this project on its own",
 *  which is what the poll and the log follow. */
function inFlight(status: ImageStatus): boolean {
  return status === 'building' || status === 'pending';
}

/** Which build a stored log belongs to. Every transition changes one half:
 *  a build that starts changes the status, one that finishes changes both. */
function imageKey(status: ImageStatus, builtAt: string | null): string {
  return `${status}|${builtAt ?? ''}`;
}

interface Field {
  input: HTMLInputElement;
  wrapper: HTMLElement;
}

interface AreaField {
  input: HTMLTextAreaElement;
  wrapper: HTMLElement;
}

/**
 * `NAME=value` per line, which is how these are written everywhere else -- a
 * `.env` file, a `docker run -e`, the table in docker/base/README.md.
 *
 * Only the first `=` splits, so a value may contain one; a blank line and a
 * `#` comment are skipped. Anything else throws, because a line that was meant
 * to be a variable and is silently dropped is worse than a refused save.
 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const at = line.indexOf('=');
    if (at < 1) throw new Error(`'${line}' is not a NAME=value line`);
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }

  return env;
}

/** Commas, spaces and newlines all separate -- the same characters the
 *  container's firewall script splits FIREWALL_ALLOW on. */
export function parseHosts(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((host) => host.trim())
    .filter((host) => host !== '');
}

export function mountProjects(root: HTMLElement, api: Api): View {
  let projects: Project[] = [];
  /** The project the form is editing, or `undefined` while it creates. */
  let editing: Project | undefined;
  /** The id whose delete button is currently asking "are you sure". */
  let confirming: string | undefined;
  /** The project whose build log is open, and the log itself once it arrives. */
  let showingLog: string | undefined;
  let logText = '';
  /** Which build the open log belongs to, as `status|builtAt`. What makes the
   *  *last* read happen after the build ended: a poll that saw `building` one
   *  beat before the build finished would otherwise leave the panel one flush
   *  short of the whole log, forever. */
  let logAt: string | undefined;
  /** Set while a build is in flight, cleared as soon as none is. */
  let poll: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const banner = el('p', { class: 'banner', hidden: 'hidden', 'data-testid': 'banner' });
  const rows = el('tbody', { 'data-testid': 'projects' });

  const textField = (
    label: string,
    name: string,
    type: string,
    placeholder: string,
    required = false,
  ): Field => {
    const input = el('input', {
      type,
      name,
      placeholder,
      autocomplete: 'off',
      'data-testid': `project-${name}`,
      ...(required ? { required: 'required' } : {}),
    });
    return { input, wrapper: el('label', {}, el('span', {}, label), input) };
  };

  const areaField = (label: string, name: string, placeholder: string): AreaField => {
    const input = el('textarea', {
      name,
      placeholder,
      rows: '3',
      autocomplete: 'off',
      spellcheck: 'false',
      'data-testid': `project-${name}`,
    });
    return { input, wrapper: el('label', {}, el('span', {}, label), input) };
  };

  const checkField = (label: string, name: string): Field => {
    const input = el('input', { type: 'checkbox', name, 'data-testid': `block-${name}` });
    return {
      input,
      wrapper: el('label', { class: 'check' }, input, el('span', {}, label)),
    };
  };

  const name = textField('Name', 'name', 'text', 'my-project', true);
  const repoUrl = textField('Repository', 'repoUrl', 'text', 'https://github.com/you/repo.git', true);
  const repoBranch = textField('Branch', 'repoBranch', 'text', 'main');
  // A PAT is a secret even on a page only you can reach: masked, never
  // remembered by the browser and never kept by this page.
  const gitToken = textField('Git token', 'gitToken', 'password', 'PAT for a private repository');
  const dotnet = checkField('dotnet SDK', 'dotnet');
  const playwright = checkField('Playwright + Chromium', 'playwright');
  // Write-only like the PAT, and for the same reason: what is typed here is
  // sealed server-side and never comes back. The box is therefore empty on
  // every edit -- what is stored shows as names below it.
  const env = areaField('Variables', 'env', 'NAME=value, one per line');
  const envNames = el('p', { class: 'hint chips', 'data-testid': 'env-names' });
  // Not secret, so this one really does show what is stored.
  const egressHosts = areaField(
    'Egress hosts',
    'egressHosts',
    'api.example.com, 10.1.0.0/16 -- on top of the server-wide list',
  );

  const submit = el('button', { type: 'submit', 'data-testid': 'project-submit' }, 'Create');
  const cancel = el(
    'button',
    { type: 'button', class: 'secondary', hidden: 'hidden', 'data-testid': 'project-cancel' },
    'Cancel',
  );
  const removeToken = el(
    'button',
    { type: 'button', class: 'secondary', hidden: 'hidden', 'data-testid': 'project-remove-token' },
    'Remove token',
  );
  const tokenHint = el('p', { class: 'hint', 'data-testid': 'token-hint' }, '');

  const form = el(
    'form',
    { class: 'create', 'data-testid': 'project-form' },
    name.wrapper,
    repoUrl.wrapper,
    repoBranch.wrapper,
    gitToken.wrapper,
    el(
      'fieldset',
      { class: 'blocks' },
      el('legend', {}, 'Environment'),
      dotnet.wrapper,
      playwright.wrapper,
    ),
    env.wrapper,
    envNames,
    egressHosts.wrapper,
    el('span', { class: 'actions' }, submit, cancel, removeToken),
    tokenHint,
  );

  const show = (element: HTMLElement, visible: boolean): void => {
    if (visible) element.removeAttribute('hidden');
    else element.setAttribute('hidden', 'hidden');
  };

  const showError = (error: unknown): void => {
    banner.textContent = describe(error);
    banner.removeAttribute('hidden');
  };

  const clearError = (): void => {
    banner.setAttribute('hidden', 'hidden');
  };

  const blocks = (): BuildingBlocks => ({
    dotnet: dotnet.input.checked,
    playwright: playwright.input.checked,
  });

  /**
   * The names of the variables the project being edited carries, each with the
   * button that removes it. Names only -- the values are write-only, exactly
   * like the PAT.
   *
   * A removal goes straight to the server rather than waiting for Save, which
   * is what the token's own Remove button does: both are "drop this stored
   * secret", and a pending removal sitting in a form is a way to lose track of
   * whether it happened.
   */
  const renderEnvNames = (): void => {
    clear(envNames);

    const stored = editing?.envNames ?? [];
    if (stored.length === 0) {
      envNames.append(
        editing === undefined
          ? 'Variables are sealed and never shown again -- only their names.'
          : 'No variables stored.',
      );
      return;
    }

    envNames.append('Stored: ');
    for (const variable of stored) {
      const drop = el(
        'button',
        {
          type: 'button',
          class: 'secondary chip',
          'data-testid': 'remove-variable',
          'data-variable': variable,
          title: `Remove ${variable}`,
        },
        `${variable} ×`,
      );
      drop.addEventListener('click', () => void dropVariable(variable));
      envNames.append(drop);
    }
  };

  const stopEditing = (): void => {
    editing = undefined;
    form.reset();
    dotnet.input.checked = false;
    playwright.input.checked = false;
    submit.textContent = 'Create';
    tokenHint.textContent = '';
    show(cancel, false);
    show(removeToken, false);
    renderEnvNames();
    renderRows();
  };

  const startEditing = (project: Project): void => {
    editing = project;
    name.input.value = project.name;
    repoUrl.input.value = project.repoUrl;
    repoBranch.input.value = project.repoBranch ?? '';
    gitToken.input.value = '';
    dotnet.input.checked = project.buildingBlocks.dotnet;
    playwright.input.checked = project.buildingBlocks.playwright;
    // Empty on purpose: there is nothing to put back, and a box that showed the
    // names without their values would look like an edit that then wiped them.
    env.input.value = '';
    egressHosts.input.value = project.egressHosts.join(', ');
    submit.textContent = 'Save';
    tokenHint.textContent = project.hasGitToken
      ? 'A token is stored. Leave the field empty to keep it.'
      : 'No token stored.';
    show(cancel, true);
    show(removeToken, project.hasGitToken);
    renderEnvNames();
    renderRows();
    name.input.focus();
  };

  /** Keeps the timer running exactly as long as something is being built. */
  const scheduleWhileBuilding = (): void => {
    const building = projects.some((project) => inFlight(project.image.status));

    if (!building || destroyed) {
      if (poll !== undefined) clearTimeout(poll);
      poll = undefined;
      return;
    }
    if (poll !== undefined) return;

    poll = setTimeout(() => {
      poll = undefined;
      void refresh();
    }, BUILD_POLL_MS);
  };

  async function refresh(): Promise<void> {
    try {
      projects = await api.listProjects();
      if (destroyed) return;
      clearError();
      renderRows();
      scheduleWhileBuilding();
    } catch (error) {
      if (destroyed) return;
      showError(error);
      return;
    }

    // The log of a build in flight grows while it runs -- the server writes it
    // away as the daemon produces it -- so an open panel is re-read here rather
    // than showing whatever was in the database when it was opened. The second
    // condition is the read *after* it: the poll stops as soon as nothing is in
    // flight, and without it the panel would keep whatever the last flush
    // happened to carry. A log belonging to a build that has not moved is not
    // fetched again -- it cannot have changed.
    const open = projects.find((project) => project.id === showingLog);
    if (open === undefined) return;
    if (inFlight(open.image.status) || imageKey(open.image.status, open.image.builtAt) !== logAt) {
      await loadLog(open.id);
    }
  }

  const rebuild = async (id: string): Promise<void> => {
    try {
      await api.buildProject(id);
      clearError();
    } catch (error) {
      showError(error);
    }
    await refresh();
  };

  /** Reads one project's build log and paints it -- unless the panel was closed
   *  or moved to another project while the request was in flight. */
  async function loadLog(id: string): Promise<void> {
    try {
      // The status comes from this answer rather than from the list: it is the
      // one the log itself was read at, which is what `refresh` compares.
      const { log, status, builtAt } = await api.projectBuildLog(id);
      if (destroyed || showingLog !== id) return;
      // A build that never ran has no log; saying so beats an empty box.
      logText = log === '' ? 'No build output yet.' : log;
      logAt = imageKey(status, builtAt);
      clearError();
    } catch (error) {
      if (destroyed) return;
      logText = '';
      showError(error);
    }
    renderRows();
  }

  const toggleLog = async (id: string): Promise<void> => {
    if (showingLog === id) {
      showingLog = undefined;
      logText = '';
      logAt = undefined;
      renderRows();
      return;
    }

    showingLog = id;
    logText = 'loading…';
    logAt = undefined;
    renderRows();
    await loadLog(id);
  };

  const save = async (): Promise<void> => {
    const value = (field: Field | AreaField): string => field.input.value.trim();
    const target = editing;

    // Before the button is disabled: a malformed line is this page's own
    // refusal, and it must leave the form exactly as it was so the line can be
    // corrected rather than retyped.
    let typed: Record<string, string>;
    try {
      typed = parseEnv(env.input.value);
    } catch (error) {
      showError(error);
      return;
    }
    const hosts = parseHosts(egressHosts.input.value);

    submit.setAttribute('disabled', 'disabled');
    try {
      if (target === undefined) {
        await api.createProject({
          name: value(name),
          repoUrl: value(repoUrl),
          repoBranch: value(repoBranch),
          gitToken: value(gitToken),
          buildingBlocks: blocks(),
          env: typed,
          egressHosts: hosts,
        });
      } else {
        await api.updateProject(target.id, {
          name: value(name),
          repoUrl: value(repoUrl),
          // Empty means "no branch" on an edit, not "unchanged": the field shows
          // what is stored, so an emptied field is a removal.
          repoBranch: value(repoBranch) === '' ? null : value(repoBranch),
          // An untouched password field keeps the stored PAT; removing it is the
          // separate button.
          ...(value(gitToken) === '' ? {} : { gitToken: value(gitToken) }),
          buildingBlocks: blocks(),
          // An empty box is "change nothing", like the password field above it:
          // what is stored is not shown, so it cannot be edited in place either.
          ...(Object.keys(typed).length === 0 ? {} : { env: typed }),
          // The hosts do show what is stored, so an emptied field is a removal
          // -- the same reading as the branch.
          egressHosts: hosts,
        });
      }
      clearError();
      stopEditing();
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      submit.removeAttribute('disabled');
    }
  };

  const dropToken = async (): Promise<void> => {
    if (editing === undefined) return;
    try {
      await api.updateProject(editing.id, { gitToken: null });
      clearError();
      stopEditing();
      await refresh();
    } catch (error) {
      showError(error);
    }
  };

  /** Removes one variable and stays in the form: unlike the token, a project
   *  usually has several, and dropping one is rarely the last thing you do. */
  const dropVariable = async (variable: string): Promise<void> => {
    const target = editing;
    if (target === undefined) return;

    try {
      editing = await api.updateProject(target.id, { env: { [variable]: null } });
      clearError();
      renderEnvNames();
      await refresh();
    } catch (error) {
      showError(error);
    }
  };

  const deleteProject = async (id: string): Promise<void> => {
    try {
      await api.removeProject(id);
      clearError();
      // The form must not keep editing a project that no longer exists.
      if (editing?.id === id) stopEditing();
    } catch (error) {
      // 409 while instances still point at it -- the server message says how
      // many, so it is shown as it is.
      showError(error);
    }
    confirming = undefined;
    await refresh();
  };

  function renderRows(): void {
    clear(rows);

    if (projects.length === 0) {
      rows.append(
        el(
          'tr',
          { 'data-testid': 'empty' },
          el('td', { colspan: '8' }, 'No projects yet. Create one above.'),
        ),
      );
      return;
    }

    for (const project of projects) {
      const edit = el(
        'button',
        { type: 'button', class: 'secondary', 'data-testid': 'edit' },
        editing?.id === project.id ? 'Editing' : 'Edit',
      );
      edit.addEventListener('click', () => {
        startEditing(project);
      });

      const remove = el(
        'button',
        {
          type: 'button',
          class: confirming === project.id ? 'danger confirm' : 'danger',
          'data-testid': confirming === project.id ? 'confirm-delete' : 'delete',
        },
        confirming === project.id ? 'Really delete?' : 'Delete',
      );
      remove.addEventListener('click', () => {
        if (confirming !== project.id) {
          confirming = project.id;
          renderRows();
          return;
        }
        void deleteProject(project.id);
      });

      const status = project.image.status;

      const rebuildButton = el(
        'button',
        { type: 'button', class: 'secondary', 'data-testid': 'rebuild' },
        status === 'building' ? 'Building…' : 'Rebuild',
      );
      // A second request during a build would only be queued behind the first.
      if (status === 'building') rebuildButton.setAttribute('disabled', 'disabled');
      rebuildButton.addEventListener('click', () => void rebuild(project.id));

      const logButton = el(
        'button',
        { type: 'button', class: 'secondary', 'data-testid': 'build-log' },
        showingLog === project.id ? 'Hide log' : 'Build log',
      );
      logButton.addEventListener('click', () => void toggleLog(project.id));

      // Everything the instances of this project get beyond the base image, in
      // one cell: the prebuilt blocks, how many variables they are handed and
      // how many extra hosts they may reach. Counts rather than values --
      // a variable's value is never shown, and the full lists are on the hover.
      const chosen = [
        project.buildingBlocks.dotnet ? 'dotnet' : undefined,
        project.buildingBlocks.playwright ? 'playwright' : undefined,
        project.envNames.length === 0
          ? undefined
          : `${String(project.envNames.length)} var${project.envNames.length === 1 ? '' : 's'}`,
        project.egressHosts.length === 0
          ? undefined
          : `${String(project.egressHosts.length)} host${project.egressHosts.length === 1 ? '' : 's'}`,
      ].filter((block) => block !== undefined);

      const environmentTitle = [...project.envNames, ...project.egressHosts].join(', ');

      rows.append(
        el(
          'tr',
          { 'data-project-id': project.id },
          el('td', { class: 'name' }, project.name),
          el('td', { class: 'repo' }, project.repoUrl),
          el('td', {}, project.repoBranch ?? '--'),
          el(
            'td',
            {
              'data-testid': 'project-environment',
              ...(environmentTitle === '' ? {} : { title: environmentTitle }),
            },
            chosen.length === 0 ? '--' : chosen.join(', '),
          ),
          el(
            'td',
            {},
            el(
              'span',
              { class: `badge ${status}`, 'data-testid': 'image-status', title: project.image.tag },
              imageLabel(status),
            ),
          ),
          el(
            'td',
            { 'data-testid': 'project-token' },
            project.hasGitToken ? 'stored' : '--',
          ),
          el('td', { 'data-testid': 'project-instances' }, String(project.instanceCount)),
          el('td', { class: 'actions' }, edit, rebuildButton, logButton, remove),
        ),
      );

      // Its own row rather than a cell: a build log is wide and the table is
      // not, and this keeps the columns from being pushed around by it.
      if (showingLog === project.id) {
        rows.append(
          el(
            'tr',
            { class: 'log-row', 'data-testid': 'log-row' },
            el('td', { colspan: '8' }, el('pre', { 'data-testid': 'log' }, logText)),
          ),
        );
      }
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save();
  });
  renderEnvNames();
  cancel.addEventListener('click', stopEditing);
  removeToken.addEventListener('click', () => void dropToken());

  clear(root);
  root.append(
    el(
      'header',
      {},
      el(
        'a',
        { class: 'back', href: routeHash({ view: 'list' }), 'data-testid': 'back' },
        '← Instances',
      ),
      el('h1', {}, 'Projects'),
      el('p', { class: 'subtitle' }, 'Templates instances are created from'),
    ),
    form,
    banner,
    el(
      'table',
      { class: 'instances' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Name'),
          el('th', {}, 'Repository'),
          el('th', {}, 'Branch'),
          el('th', {}, 'Environment'),
          el('th', {}, 'Image'),
          el('th', {}, 'Token'),
          el('th', {}, 'Instances'),
          el('th', {}, ''),
        ),
      ),
      rows,
    ),
  );

  renderRows();
  void refresh();

  return {
    destroy: () => {
      destroyed = true;
      if (poll !== undefined) clearTimeout(poll);
      poll = undefined;
    },
  };
}
