/**
 * One instance console: xterm.js on one end, the terminal bridge on the other.
 *
 * Nothing about the session lives here. Scrollback, the running Claude and the
 * geometry are in the container's tmux session, which is why a reload is a
 * reconnect and not a restore.
 */

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { ApiCallError, type Api } from '../api.ts';
import { clear, el } from '../dom.ts';
import { routeHash } from '../router.ts';
import {
  connectTerminal,
  type TerminalConnection,
  type TerminalNotice,
  type TerminalSize,
} from '../terminal/session.ts';
import type { View } from './view.ts';

/** A drag on the window edge fires dozens of resizes; tmux only needs the one
 *  the user stopped at. */
const RESIZE_DEBOUNCE_MS = 100;

export function mountConsole(root: HTMLElement, api: Api, id: string): View {
  let connection: TerminalConnection | undefined;
  let lastNotice: TerminalNotice | undefined;
  let resizeTimer: number | undefined;
  let sent: TerminalSize = { cols: 0, rows: 0 };
  let destroyed = false;

  const title = el('h1', { 'data-testid': 'instance-name' }, id);
  const status = el('span', { class: 'status-text', 'data-testid': 'status' }, 'connecting');
  const reconnect = el(
    'button',
    { type: 'button', hidden: 'hidden', 'data-testid': 'reconnect' },
    'Reconnect',
  );
  const screen = el('div', { class: 'screen', 'data-testid': 'terminal' });

  const terminal = new Terminal({
    // 10_000 lines is xterm's side of the scrollback; the container keeps its
    // own, which is the one that survives a reload.
    scrollback: 10_000,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace',
    fontSize: 14,
    theme: { background: '#12151b', foreground: '#d6dae2', cursor: '#9ecbff' },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);

  const setStatus = (text: string, state: string): void => {
    status.textContent = text;
    status.setAttribute('data-state', state);
  };

  const geometry = (): TerminalSize => ({ cols: terminal.cols, rows: terminal.rows });

  const connect = (): void => {
    connection?.close();
    lastNotice = undefined;
    reconnect.setAttribute('hidden', 'hidden');
    fit.fit();
    sent = geometry();
    setStatus('connecting', 'connecting');

    connection = connectTerminal(id, sent, {
      onOpen: () => {
        setStatus(`connected · ${String(sent.cols)}×${String(sent.rows)}`, 'connected');
        terminal.focus();
      },
      // Bytes, not a decoded string: a multi-byte character can be split across
      // two frames and xterm's own decoder is the one that keeps that state
      // (knowledge/xterm-write-bytes-not-strings.md).
      onOutput: (bytes) => terminal.write(bytes),
      onNotice: (notice) => {
        lastNotice = notice;
      },
      onClose: (message) => {
        if (destroyed) return;
        const detail = lastNotice === undefined ? message : `${message} (${lastNotice.message})`;
        setStatus(`disconnected · ${detail}`, 'disconnected');
        reconnect.removeAttribute('hidden');
        connection = undefined;
      },
    });
  };

  // Keystrokes go out as binary frames on purpose: a text frame is read as a
  // control message first, so pasting a JSON object would be swallowed instead
  // of typed (knowledge/terminal-input-must-be-binary.md).
  const encoder = new TextEncoder();
  terminal.onData((data) => connection?.send(encoder.encode(data)));
  terminal.onBinary((data) =>
    connection?.send(Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff)),
  );

  const applyFit = (): void => {
    fit.fit();
    const next = geometry();
    if (next.cols === sent.cols && next.rows === sent.rows) return;
    sent = next;
    connection?.resize(next);
    if (status.getAttribute('data-state') === 'connected') {
      setStatus(`connected · ${String(next.cols)}×${String(next.rows)}`, 'connected');
    }
  };

  const observer = new ResizeObserver(() => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(applyFit, RESIZE_DEBOUNCE_MS);
  });

  reconnect.addEventListener('click', connect);

  clear(root);
  root.append(
    el(
      'header',
      { class: 'console-header' },
      el('a', { class: 'back', href: routeHash({ view: 'list' }), 'data-testid': 'back' }, '← Instances'),
      title,
      el('span', { class: 'status-line' }, status, reconnect),
    ),
    screen,
  );

  terminal.open(screen);
  observer.observe(screen);
  connect();

  // Cosmetic, and last: a console that works but says the id instead of the
  // name is better than one that waits for a REST round trip to appear.
  void api
    .get(id)
    .then((instance) => {
      if (!destroyed) title.textContent = instance.name;
    })
    .catch((error: unknown) => {
      // 404 is already visible as the 4404 close code -- no second complaint.
      if (!(error instanceof ApiCallError)) throw error;
    });

  return {
    destroy: () => {
      destroyed = true;
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      observer.disconnect();
      connection?.close();
      terminal.dispose();
    },
  };
}
