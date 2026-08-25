/**
 * The instance list: create, see the status Docker reports, open the console,
 * delete.
 *
 * The table body is re-rendered on every poll, the shell around it is not --
 * otherwise typing in the create form would lose focus every three seconds.
 */

import { ApiCallError, type Api, type Instance } from '../api.ts';
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

  const form = el(
    'form',
    { class: 'create', 'data-testid': 'create-form' },
    field('Name', 'name', 'text', 'my-instance', true),
    field('Repository', 'repoUrl', 'text', 'https://github.com/you/repo.git'),
    field('Branch', 'repoBranch', 'text', 'main'),
    // A PAT is a secret even on a page only you can reach: masked, never
    // remembered by the browser and never kept by this page.
    field('Git token', 'gitToken', 'password', 'PAT for a private repository'),
    submit,
  );

  const showError = (error: unknown): void => {
    banner.textContent = describe(error);
    banner.removeAttribute('hidden');
  };

  const clearError = (): void => {
    banner.setAttribute('hidden', 'hidden');
  };

  const renderRows = (): void => {
    clear(rows);

    if (instances.length === 0) {
      rows.append(
        el(
          'tr',
          { 'data-testid': 'empty' },
          el('td', { colspan: '6' }, 'No instances yet. Create one above.'),
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
      await api.create({
        name: value('name'),
        repoUrl: value('repoUrl'),
        repoBranch: value('repoBranch'),
        gitToken: value('gitToken'),
      });
      // Reset before the refresh, so the token does not sit in the DOM any
      // longer than the request took.
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

  clear(root);
  root.append(
    el(
      'header',
      {},
      el('h1', {}, 'claudops'),
      el('p', { class: 'subtitle' }, 'Claude Code instances on the NUC'),
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
          el('th', {}, 'Repository'),
          el('th', {}, 'Branch'),
          el('th', {}, 'Age'),
          el('th', {}, ''),
        ),
      ),
      rows,
    ),
  );

  renderRows();
  void refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);

  return {
    destroy: () => {
      destroyed = true;
      clearInterval(timer);
    },
  };
}
