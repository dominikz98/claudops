/**
 * The login: one shared secret, one field.
 *
 * There are no accounts -- claudops runs on a LAN and the thing being protected
 * is "who may start, delete and type into a console", not "who is this". A
 * session cookie comes back and the browser sends it on every request and on the
 * terminal upgrade by itself.
 *
 * This view is the reason the SPA shell is served without a session: it is the
 * only thing an unauthenticated browser can reach, and it carries no data.
 */

import { ApiCallError, type Api } from '../api.ts';
import { clear, el } from '../dom.ts';
import { navigate } from '../router.ts';
import type { View } from './view.ts';

function describe(error: unknown): string {
  if (error instanceof ApiCallError) {
    // The two the server distinguishes deliberately, said in words rather than
    // as a code -- this form is the one page a person reads before logging in.
    if (error.code === 'invalid_secret') return 'Wrong secret.';
    if (error.code === 'too_many_attempts') return error.message;
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function mountLogin(root: HTMLElement, api: Api): View {
  let destroyed = false;

  const banner = el('p', { class: 'banner', hidden: 'hidden', 'data-testid': 'banner' });
  const secret = el('input', {
    type: 'password',
    name: 'secret',
    required: 'required',
    autocomplete: 'current-password',
    'data-testid': 'secret',
  });
  const submit = el('button', { type: 'submit', 'data-testid': 'login' }, 'Log in');

  const showError = (error: unknown): void => {
    banner.textContent = describe(error);
    banner.hidden = false;
  };

  const form = el(
    'form',
    { class: 'create', 'data-testid': 'login-form' },
    el('label', {}, 'Shared secret', secret),
    el('div', { class: 'actions' }, submit),
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    banner.hidden = true;
    submit.disabled = true;

    void (async () => {
      try {
        await api.login(secret.value);
        if (destroyed) return;
        // Cleared before leaving: the field would otherwise still hold the
        // secret if the browser restored this view from its back stack.
        secret.value = '';
        navigate({ view: 'list' });
      } catch (error) {
        if (destroyed) return;
        showError(error);
        secret.select();
      } finally {
        if (!destroyed) submit.disabled = false;
      }
    })();
  });

  clear(root);
  root.append(
    el(
      'header',
      {},
      el('h1', {}, 'claudops'),
      el('p', { class: 'subtitle' }, 'Log in to reach the instances'),
    ),
    form,
    banner,
  );

  secret.focus();

  return {
    destroy: () => {
      destroyed = true;
    },
  };
}
