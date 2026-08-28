/**
 * The instance list: create from a project, see the status Docker reports, open
 * the console, delete.
 *
 * The table body is re-rendered on every poll, the shell around it is not --
 * otherwise typing in the create form would lose focus every three seconds.
 * The project list is fetched once: it only changes on the projects page, and
 * navigating back here mounts this view again anyway.
 */

import {
  ApiCallError,
  type Api,
  type Instance,
  type Project,
  type SessionReadiness,
} from '../api.ts';
import { clear, el, relativeTime } from '../dom.ts';
import { navigate, routeHash } from '../router.ts';
import type { View } from './view.ts';

/** Docker state changes without anyone asking, so the list asks. */
const POLL_MS = 3000;

const STATUS_HINTS: Record<string, string> = {
  running: 'The container is up. Whether its session is, is the badge next to it.',
  exited: 'The container is stopped. Start brings it back with its workspace.',
  missing: 'The server has a row but Docker has no container. Only Delete is left.',
};

/** The second axis: a container is `running` minutes before its tmux session
 *  exists, and only the session is what a console attaches to. */
const SESSION_HINTS: Record<SessionReadiness, string> = {
  none: 'No running container -- there is nothing to attach a console to.',
  starting: 'The container is up, its session is not yet. The console opens as soon as it is.',
  ready: 'The session is up and the console can be attached.',
  failed: 'The container never reached its session. `docker logs` on it says why.',
};

/** Which way the power button points, by Docker state. `missing` is in neither
 *  list -- there is no container to stop and none to start -- and neither is
 *  `paused`, which needs an unpause rather than a start. */
const RUNNING_STATES = new Set(['running', 'restarting']);
const STARTABLE_STATES = new Set(['exited', 'created']);

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

  /** Only here, not on every page: this is the view everything else is reached
   *  from, and one logout is enough for a LAN prototype. */
  const logout = el('button', { class: 'secondary logout', 'data-testid': 'logout' }, 'Log out');
  logout.addEventListener('click', () => {
    void (async () => {
      try {
        await api.logout();
      } catch {
        // The cookie is gone from the browser either way; the form is where the
        // user wants to end up, and it says so itself if the server is down.
      }
      navigate({ view: 'login' });
    })();
  });
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

  /**
   * Stop or Start, whichever the instance's state allows -- and nothing at all
   * for a state where neither would work. No confirmation: a stop keeps the
   * container and everything in it, so the worst case is pressing Start again.
   */
  const powerButton = (instance: Instance): HTMLElement | undefined => {
    const running = RUNNING_STATES.has(instance.status);
    if (!running && !STARTABLE_STATES.has(instance.status)) return undefined;

    const button = el(
      'button',
      { type: 'button', class: 'secondary', 'data-testid': running ? 'stop' : 'start' },
      running ? 'Stop' : 'Start',
    );
    button.addEventListener('click', () => {
      // The list is re-rendered on the next poll, and until then this button
      // must not be pressed a second time.
      button.setAttribute('disabled', 'disabled');
      void power(instance.id, running);
    });
    return button;
  };

  /**
   * The Docker state and, next to it, whether the session behind it is up.
   * Two elements rather than one string: `status` is the raw Docker word and
   * stays that, so a reader (and a test) can keep asking for exactly it.
   */
  const statusCell = (instance: Instance): HTMLElement => {
    const cell = el(
      'td',
      { class: `status status-${instance.status}`, title: STATUS_HINTS[instance.status] ?? '' },
      el('span', { 'data-testid': 'status' }, instance.status),
    );

    // Nothing to add for a container that is not running: `exited` and
    // `missing` are already the whole answer.
    if (instance.session !== 'none') {
      cell.append(
        el(
          'span',
          {
            class: `badge ${instance.session}`,
            'data-testid': 'session',
            title: SESSION_HINTS[instance.session],
          },
          instance.session,
        ),
      );
    }

    return cell;
  };

  /**
   * A link only while the session is attachable. Otherwise a disabled button:
   * an anchor has no disabled state, and one that is merely painted grey is
   * still clickable, still followed by the keyboard, and would open a console
   * whose only possible answer is that there is nothing to attach to.
   */
  const consoleControl = (instance: Instance): HTMLElement => {
    if (instance.session === 'ready') {
      return el(
        'a',
        {
          class: 'open',
          href: routeHash({ view: 'console', id: instance.id }),
          'data-testid': 'console',
        },
        'Console',
      );
    }

    return el(
      'button',
      {
        type: 'button',
        class: 'open',
        disabled: 'disabled',
        'data-testid': 'console',
        title: SESSION_HINTS[instance.session],
      },
      'Console',
    );
  };

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
      const open = consoleControl(instance);
      const power = powerButton(instance);

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
          statusCell(instance),
          el('td', { 'data-testid': 'project' }, projectName(instance.projectId)),
          // The repository as the container was told it, not as the project
          // reads today.
          el('td', { class: 'repo' }, instance.repoUrl ?? '--'),
          el('td', {}, instance.repoBranch ?? '--'),
          el('td', { title: instance.createdAt }, relativeTime(instance.createdAt)),
          el('td', { class: 'actions' }, open, ...(power === undefined ? [] : [power]), remove),
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

  const power = async (id: string, running: boolean): Promise<void> => {
    try {
      await (running ? api.stop(id) : api.start(id));
      clearError();
    } catch (error) {
      showError(error);
    }
    await refresh();
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
      logout,
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
