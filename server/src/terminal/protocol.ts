/**
 * Wire format of the terminal WebSocket.
 *
 * Two channels on one socket, split by frame type: **binary frames are terminal
 * bytes**, **text frames are JSON control messages**. Nothing is framed inside
 * the binary channel -- what arrives is what the TTY sends and receives.
 *
 * Text frames that are not a JSON object are forwarded as input instead of
 * being rejected. That is what makes `wscat` a usable test client: it sends
 * text, and typing `ls` there should type `ls` in the container. A real client
 * sends keystrokes as binary and never hits the distinction.
 */

import type { TerminalSize } from '../docker/engine.ts';

/**
 * Close codes. 4xxx is the private range; the last three digits mirror the HTTP
 * status the same condition would get on a REST route, so a reader needs no
 * table for them.
 */
export const TerminalClose = {
  /** The exec ended: tmux detached, the shell exited, the container stopped. */
  sessionEnded: 1000,
  /** No such instance. */
  notFound: 4404,
  /** The instance exists but has no attachable container. */
  conflict: 4409,
  /** The server broke. */
  internal: 4500,
  /** The Docker daemon did not answer. */
  dockerUnavailable: 4503,
} as const;

export type ClientFrame =
  | { kind: 'input'; data: Uint8Array }
  | { kind: 'resize'; size: TerminalSize }
  | { kind: 'invalid'; message: string };

/** A pane below 1 cell is meaningless, above 1000 no terminal exists. Both ends
 *  keep a bad client from being passed on to the Docker API. */
const MIN_CELLS = 1;
const MAX_CELLS = 1000;

/** WebSocket close reasons are capped at 123 bytes on the wire; a longer one
 *  makes `ws` throw instead of closing. */
const MAX_REASON_BYTES = 100;

function cells(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= MIN_CELLS && value <= MAX_CELLS ? value : undefined;
}

function decodeControl(message: Record<string, unknown>): ClientFrame {
  if (message.type !== 'resize') {
    return {
      kind: 'invalid',
      message:
        typeof message.type === 'string'
          ? `unknown message type '${message.type}'`
          : 'message needs a string type',
    };
  }

  const cols = cells(message.cols);
  const rows = cells(message.rows);
  if (cols === undefined || rows === undefined) {
    return {
      kind: 'invalid',
      message: `resize needs integer cols and rows between ${MIN_CELLS} and ${MAX_CELLS}`,
    };
  }

  return { kind: 'resize', size: { cols, rows } };
}

export function decodeClientFrame(data: Uint8Array, isBinary: boolean): ClientFrame {
  if (isBinary) return { kind: 'input', data };

  const text = Buffer.from(data).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON, so it is what somebody typed.
    return { kind: 'input', data };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'input', data };
  }

  return decodeControl(parsed as Record<string, unknown>);
}

/**
 * Geometry from the connect URL (`?cols=120&rows=40`). Optional, and anything
 * unparseable is ignored rather than refused -- a bad query string must not cost
 * somebody their console, and the client's first resize message fixes it anyway.
 */
export function parseSizeQuery(cols: unknown, rows: unknown): TerminalSize | undefined {
  const asNumber = (value: unknown): unknown => (typeof value === 'string' ? Number(value) : value);
  const parsedCols = cells(asNumber(cols));
  const parsedRows = cells(asNumber(rows));
  return parsedCols === undefined || parsedRows === undefined
    ? undefined
    : { cols: parsedCols, rows: parsedRows };
}

/** Sent as a text frame before a close, so a client has something to show
 *  besides a numeric code. */
export function errorFrame(code: string, message: string): string {
  return JSON.stringify({ type: 'error', code, message });
}

export function closeReason(text: string): string {
  // Character-wise, not byte-wise: cutting a buffer mid-sequence turns the
  // remainder into a 3-byte replacement character and can push it back over
  // the limit.
  let reason = text;
  while (Buffer.byteLength(reason, 'utf8') > MAX_REASON_BYTES) {
    reason = reason.slice(0, -1);
  }
  return reason;
}
