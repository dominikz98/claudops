/**
 * The instance list: create from a project, see the status Docker reports, open
 * the console, delete.
 *
 * The table body is re-rendered on every poll, the shell around it is not --
 * otherwise typing in the create form would lose focus every three seconds.
 * The project list is fetched once: it only changes on the projects page, and
 * navigating back here mounts this view again anyway.
 */

import { ApiCallError, type Api, type Instance, type Project } from '../api.ts';
import { clear, el, relativeTime } from '../dom.ts';
import { routeHash } from '../router.ts';
import type { View } from './view.ts';

/** Docker state changes without anyone asking, so the list asks. */
const POLL_MS = 3000;

const STATUS_HINTS: Record<string, string> = {
  running: 'The container is up and the console can be attached.',
  exited: 'The container stopped. The instance can still be deleted.',
  missing: 'The server has a row but Docker has no container.',
};

function describe(error: unknown): string {
  if (error instanceof ApiCallError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function mountList(root: HTMLElement, api: Api): View {
  let instances: Instance[] = [];
  let projects: Project[] = [];
  /** The id whose delete button is currently asking "are you sure". */
  let confirming: string | undefined;
  let destroyed = false;

  const banner = el('p', { class: 'banner', hidden: 'hidden', 'data-testid': 'banner' });
  const rows = el('tbody', { 'data-testid': 'instances' });
  const submit = el('button', { type: 'submit', 'data-testid': 'create-submit' }, 'Create');

  const field = (
    label: string,
    name: string,
    type: string,
    placeholder: string,
    required = false,
  ): HTMLElement => {
    const input = el('input', {
      type,
      name,
      placeholder,
      autocomplete: 'off',
      'data-testid': name,
      ...(required ? { required: 'required' } : {}),
    });
    return el('label', {}, el('span', {}, label), input);
  };

  // Repository, branch and PAT are the project's now -- picking one is the whole
  // configuration an instance has.
  const projectSelect = el('select', {
    name: 'projectId',
    required: 'required',
    'data-testid': 'projectId',
  });

  const projectHint = el(
    'p',
    { class: 'hint', hidden: 'hidden', 'data-testid': 'no-projects' },
    'No projects yet -- ',
    el('a', { href: routeHash({ view: 'projects' }) }, 'create one first'),
    '.',
  );

  const form = el(
    'form',
    { class: 'create', 'data-testid': 'create-form' },
    field('Name', 'name', 'text', 'my-instance', true),
    el('label', {}, el('span', {}, 'Project'), projectSelect),
    submit,
    projectHint,
  );

  const showError = (error: unknown): void => {
    banner.textContent = describe(error);
    banner.removeAttribute('hidden');
  };

  const clearError = (): void => {
    banner.setAttribute('hidden', 'hidden');
  };

  /** Renders the picker and, when there is nothing to pick, says so instead of
   *  offering an empty dropdown.
   *
   *  A project whose image is not built yet is shown but not selectable: the
   *  server would answer 422, and reading why on the option beats reading it in
   *  a banner after submitting. */
  const renderProjects = (): void => {
    clear(projectSelect);
    for (const project of projects) {
      const ready = project.image.status === 'ready';
      projectSelect.append(
        el(
          'option',
          { value: project.id, ...(ready ? {} : { disabled: 'disabled' }) },
          ready ? project.name : `${project.name} (image ${project.image.status})`,
        ),
      );
    }

    const usable = projects.some((project) => project.image.status === 'ready');
    if (usable) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', 'disabled');

    // A disabled Create needs a reason next to it, and "no projects" and "no
    // built image yet" are different problems with different fixes.
    if (usable) {
      projectHint.setAttribute('hidden', 'hidden');
      return;
    }

    clear(projectHint);
    projectHint.append(
      projects.length === 0 ? 'No projects yet -- ' : 'No project image is built yet -- ',
      el(
        'a',
        { href: routeHash({ view: 'projects' }) },
        projects.length === 0 ? 'create one first' : 'watch the build',
      ),
      '.',
    );
    projectHint.removeAttribute('hidden');
  };

  const projectName = (id: string | null): string =>
    projects.find((project) => project.id === id)?.name ?? '--';

  const renderRows = (): void => {
    clear(rows);

    if (instances.length === 0) {
      rows.append(
        el(
          'tr',
          { 'data-testid': 'empty' },
          el('td', { colspan: '7' }, 'No instances yet. Create one above.'),
        ),
      );
      return;
    }

    for (const instance of instances) {
      const open = el(
        'a',
        { class: 'open', href: routeHash({ view: 'console', id: instance.id }) },
        'Console',
      );

      const remove = el(
        'button',
        {
          type: 'button',
          class: confirming === instance.id ? 'danger confirm' : 'danger',
          'data-testid': confirming === instance.id ? 'confirm-delete' : 'delete',
        },
        confirming === instance.id ? 'Really delete?' : 'Delete',
      );
      remove.addEventListener('click', () => {
        if (confirming !== instance.id) {
          confirming = instance.id;
          renderRows();
          return;
        }
        void deleteInstance(instance.id);
      });

      rows.append(
        el(
          'tr',
          { 'data-instance-id': instance.id },
          el('td', { class: 'name' }, instance.name),
          el(
            'td',
            {
              class: `status status-${instance.status}`,
              'data-testid': 'status',
              title: STATUS_HINTS[instance.status] ?? '',
            },
            instance.status,
          ),
          el('td', { 'data-testid': 'project' }, projectName(instance.projectId)),
          // The repository as the container was told it, not as the project
          // reads today.
          el('td', { class: 'repo' }, instance.repoUrl ?? '--'),
          el('td', {}, instance.repoBranch ?? '--'),
          el('td', { title: instance.createdAt }, relativeTime(instance.createdAt)),
          el('td', { class: 'actions' }, open, remove),
        ),
      );
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      instances = await api.list();
      if (destroyed) return;
      clearError();
      renderRows();
    } catch (error) {
      if (destroyed) return;
      // The last known list stays on screen: a daemon that went away for a
      // moment should not blank the page.
      showError(error);
    }
  };

  const deleteInstance = async (id: string): Promise<void> => {
    try {
      await api.remove(id);
    } catch (error) {
      showError(error);
    }
    confirming = undefined;
    await refresh();
  };

  const create = async (): Promise<void> => {
    const data = new FormData(form);
    // FormData can hand back a File; these fields never are, and a non-string
    // is treated as empty rather than stringified into nonsense.
    const value = (name: string): string => {
      const raw = data.get(name);
      return typeof raw === 'string' ? raw.trim() : '';
    };

    submit.setAttribute('disabled', 'disabled');
    try {
      await api.create({ name: value('name'), projectId: value('projectId') });
      form.reset();
      clearError();
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      submit.removeAttribute('disabled');
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void create();
  });

  /** Fetched once, not polled: only the projects page changes this list. */
  const loadProjects = async (): Promise<void> => {
    try {
      projects = await api.listProjects();
      if (destroyed) return;
      renderProjects();
      renderRows();
    } catch (error) {
      if (destroyed) return;
      showError(error);
    }
  };

  clear(root);
  root.append(
    el(
      'header',
      {},
      el('h1', {}, 'claudops'),
      el('p', { class: 'subtitle' }, 'Claude Code instances on the NUC'),
      el(
        'a',
        { class: 'nav', href: routeHash({ view: 'projects' }), 'data-testid': 'projects-link' },
        'Projects →',
      ),
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
          el('th', {}, 'Status'),
          el('th', {}, 'Project'),
          el('th', {}, 'Repository'),
          el('th', {}, 'Branch'),
          el('th', {}, 'Age'),
          el('th', {}, ''),
        ),
      ),
      rows,
    ),
  );

  renderProjects();
  renderRows();
  void loadProjects();
  void refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);

  return {
    destroy: () => {
      destroyed = true;
      clearInterval(timer);
    },
  };
}
