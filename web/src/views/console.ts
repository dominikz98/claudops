/**
 * One instance console: xterm.js on one end, the terminal bridge on the other,
 * and a way to hand the instance a file.
 *
 * Nothing about the session lives here. Scrollback, the running Claude and the
 * geometry are in the container's tmux session, which is why a reload is a
 * reconnect and not a restore. An attachment does not live here either: it goes
 * to the server as bytes, and what comes back is the path the server already
 * typed into the pane.
 *
 * The files panel is the other direction, and is mounted next to the screen
 * rather than inside it -- see views/files.ts.
 */

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { ApiCallError, type Api } from '../api.ts';
import { clear, el } from '../dom.ts';
import { routeHash } from '../router.ts';
import { pastedFileName } from '../upload.ts';
import { mountFiles, type FilesPanel } from './files.ts';
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

/** One file on its way up, with the name it should carry -- which is not always
 *  the one it has: a pasted screenshot is `image.png` every time. */
interface Attachment {
  name: string;
  blob: Blob;
}

function describe(error: unknown): string {
  if (error instanceof ApiCallError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** A clipboard image carries a name only by convention, and always the same
 *  one. Anything else keeps what it was called. */
function attachmentsOf(files: readonly File[], fromClipboard: boolean): Attachment[] {
  return files.map((file) => ({
    name: fromClipboard && file.type.startsWith('image/') ? pastedFileName(file.type) : file.name,
    blob: file,
  }));
}

export function mountConsole(root: HTMLElement, api: Api, id: string): View {
  let connection: TerminalConnection | undefined;
  let lastNotice: TerminalNotice | undefined;
  let resizeTimer: number | undefined;
  let sent: TerminalSize = { cols: 0, rows: 0 };
  let destroyed = false;
  /** Mounted on the first open rather than with the page: an operator who only
   *  wants the console should not cost the instance a directory listing. */
  let files: FilesPanel | undefined;
  /** One upload at a time, so the Attach button cannot start a second run over
   *  a queue that is still being worked through. */
  let uploading = false;

  const title = el('h1', { 'data-testid': 'instance-name' }, id);
  const status = el('span', { class: 'status-text', 'data-testid': 'status' }, 'connecting');
  const reconnect = el(
    'button',
    { type: 'button', hidden: 'hidden', 'data-testid': 'reconnect' },
    'Reconnect',
  );
  const screen = el('div', { class: 'screen', 'data-testid': 'terminal' });

  // Three ways in, one code path behind them: the picker, a drop on the screen
  // and a paste that carries files rather than text.
  const picker = el('input', {
    type: 'file',
    multiple: 'multiple',
    hidden: 'hidden',
    'data-testid': 'attach-input',
  });
  const attach = el(
    'button',
    { type: 'button', class: 'secondary', 'data-testid': 'attach' },
    'Attach',
  );
  const showFiles = el(
    'button',
    { type: 'button', class: 'secondary', 'aria-pressed': 'false', 'data-testid': 'files-toggle' },
    'Files',
  );
  const uploadStatus = el('span', {
    class: 'upload-status',
    hidden: 'hidden',
    'data-testid': 'upload-status',
  });

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
  // A run prints artefact paths and PR links; without this they are text that
  // has to be selected out of a terminal by hand.
  terminal.loadAddon(new WebLinksAddon());

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

  const setUpload = (text: string, state: string): void => {
    uploadStatus.textContent = text;
    uploadStatus.setAttribute('data-state', state);
    uploadStatus.removeAttribute('hidden');
  };

  /**
   * One request per file, one after the other: the server types every path into
   * the pane, so two uploads in flight would interleave their paths in the
   * prompt. Three files dropped together are three lines, in the order they
   * were dropped.
   */
  const send = async (attachments: readonly Attachment[]): Promise<void> => {
    if (attachments.length === 0 || uploading) return;

    uploading = true;
    attach.setAttribute('disabled', 'disabled');
    try {
      for (const [index, attachment] of attachments.entries()) {
        const of = attachments.length > 1 ? ` (${String(index + 1)}/${String(attachments.length)})` : '';
        setUpload(`uploading ${attachment.name}${of}`, 'busy');

        const upload = await api.upload(id, attachment.name, attachment.blob);
        setUpload(
          upload.announced
            ? `attached ${upload.path}`
            : `uploaded to ${upload.path} -- the session is not up, so nothing was typed`,
          upload.announced ? 'done' : 'warn',
        );
      }
      // The uploads directory has one more file in it than the panel knows
      // about.
      files?.refresh();
      // The path is in the prompt now; the cursor should be there too.
      terminal.focus();
    } catch (error) {
      setUpload(describe(error), 'error');
    } finally {
      uploading = false;
      attach.removeAttribute('disabled');
    }
  };

  attach.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const files = [...(picker.files ?? [])];
    // Cleared so the same file can be picked a second time -- otherwise the
    // input reports no change and nothing happens.
    picker.value = '';
    void send(attachmentsOf(files, false));
  });

  // Without preventDefault on dragover the browser navigates to the file
  // instead of letting it be dropped.
  screen.addEventListener('dragover', (event) => {
    event.preventDefault();
    screen.classList.add('dropping');
  });
  screen.addEventListener('dragleave', () => screen.classList.remove('dropping'));
  screen.addEventListener('drop', (event) => {
    event.preventDefault();
    screen.classList.remove('dropping');
    void send(attachmentsOf([...(event.dataTransfer?.files ?? [])], false));
  });

  // Capture, and only when the clipboard really carries files: a text paste has
  // to reach xterm untouched, which is where bracketed paste comes from.
  screen.addEventListener(
    'paste',
    (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void send(attachmentsOf(files, true));
    },
    true,
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

  // The screen and the panel share one row, so opening the panel makes the
  // terminal narrower rather than pushing it off the page. xterm reflows into
  // whatever is left because the ResizeObserver below watches the screen.
  const split = el('div', { class: 'console-split' }, screen);

  /** Opens and closes the panel. The terminal is not touched: the observer
   *  sees the screen change width and refits it. */
  const toggleFiles = (): void => {
    if (files === undefined) {
      files = mountFiles(api, id);
      split.append(files.element);
      showFiles.setAttribute('aria-pressed', 'true');
      return;
    }
    files.element.remove();
    files.destroy();
    files = undefined;
    showFiles.setAttribute('aria-pressed', 'false');
    terminal.focus();
  };

  showFiles.addEventListener('click', toggleFiles);

  clear(root);
  root.append(
    el(
      'header',
      { class: 'console-header' },
      el('a', { class: 'back', href: routeHash({ view: 'list' }), 'data-testid': 'back' }, '← Instances'),
      title,
      el('span', { class: 'status-line' }, uploadStatus, status, showFiles, attach, reconnect, picker),
    ),
    split,
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
      files?.destroy();
      terminal.dispose();
    },
  };
}
