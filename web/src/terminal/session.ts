/**
 * The browser end of the terminal bridge.
 *
 * Two channels on one socket, exactly as `server/src/terminal/protocol.ts`
 * defines them: binary frames are terminal bytes, text frames are JSON control
 * messages. Both distinctions matter here and are easy to get wrong -- see
 * knowledge/terminal-input-must-be-binary.md and
 * knowledge/xterm-write-bytes-not-strings.md.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** A `{"type":"error",...}` frame from the server. Not fatal by itself. */
export interface TerminalNotice {
  code: string;
  message: string;
}

export interface TerminalHandlers {
  onOpen(): void;
  /** Raw bytes off the wire. Hand them to xterm undecoded. */
  onOutput(bytes: Uint8Array): void;
  onNotice(notice: TerminalNotice): void;
  onClose(message: string): void;
}

export interface TerminalConnection {
  /** Keystrokes. Always a binary frame. */
  send(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  close(): void;
}

/** The close codes from `server/src/terminal/protocol.ts`, plus the one the
 *  browser makes up when a connection dies without a close frame. */
const CLOSE_MESSAGES: Record<number, string> = {
  1000: 'session ended -- detached, or the process in the pane exited',
  1006: 'connection lost',
  4404: 'no such instance',
  4409: 'the instance has no running container to attach to',
  4500: 'the server failed to attach to the container',
  4503: 'the Docker daemon is unreachable',
};

export function closeMessage(code: number, reason = ''): string {
  const known = CLOSE_MESSAGES[code];
  if (known !== undefined) return known;
  return reason === '' ? `connection closed with code ${code}` : reason;
}

/**
 * The geometry travels in the query string so the very first redraw already
 * arrives in the right size instead of painting at 80x24 and reflowing.
 * `location` is a parameter so this can be asserted without a browser.
 */
export function terminalUrl(
  id: string,
  size: TerminalSize,
  location: Pick<Location, 'protocol' | 'host'>,
): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = `cols=${String(size.cols)}&rows=${String(size.rows)}`;
  return `${scheme}//${location.host}/instances/${encodeURIComponent(id)}/terminal?${query}`;
}

function parseNotice(text: string): TerminalNotice | undefined {
  try {
    const parsed = JSON.parse(text) as { type?: unknown; code?: unknown; message?: unknown };
    if (parsed.type !== 'error') return undefined;
    return {
      code: typeof parsed.code === 'string' ? parsed.code : 'error',
      message: typeof parsed.message === 'string' ? parsed.message : text,
    };
  } catch {
    return undefined;
  }
}

export function connectTerminal(
  id: string,
  size: TerminalSize,
  handlers: TerminalHandlers,
): TerminalConnection {
  const socket = new WebSocket(terminalUrl(id, size, window.location));
  // Without this the browser hands out Blobs and every frame would have to be
  // read asynchronously -- which reorders terminal output.
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    handlers.onOpen();
  });

  socket.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
    if (typeof event.data === 'string') {
      const notice = parseNotice(event.data);
      if (notice !== undefined) handlers.onNotice(notice);
      return;
    }
    handlers.onOutput(new Uint8Array(event.data));
  });

  socket.addEventListener('close', (event: CloseEvent) => {
    handlers.onClose(closeMessage(event.code, event.reason));
  });

  const ifOpen = (send: () => void): void => {
    if (socket.readyState === WebSocket.OPEN) send();
  };

  return {
    send: (bytes) => {
      ifOpen(() => {
        socket.send(bytes);
      });
    },
    resize: (next) => {
      ifOpen(() => {
        socket.send(JSON.stringify({ type: 'resize', cols: next.cols, rows: next.rows }));
      });
    },
    close: () => {
      // The server answers a closed socket by sending tmux its detach sequence,
      // which is what keeps the pane from being sized by a client that is gone.
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'client closed');
      }
    },
  };
}
