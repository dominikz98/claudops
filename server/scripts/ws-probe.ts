/**
 * WebSocket client for the terminal smoke test: connect, run a list of steps,
 * print what came back.
 *
 *   pnpm --filter @claudops/server exec tsx scripts/ws-probe.ts <url> [steps...]
 *
 * Steps, in order:
 *   input:<text>          one binary frame -- keystrokes, the way the web UI sends them
 *   line:<text>           the same plus a carriage return, so a shell runs it
 *   text:<text>           one text frame -- the way `wscat` sends them
 *   textline:<text>       the same plus a carriage return
 *   resize:<cols>x<rows>  a resize control message
 *   wait:<needle>         block until the output received so far contains <needle>
 *   sleep:<ms>            wait, for instance to let the pane settle
 *
 * Options:
 *   --timeout <ms>        how long a `wait` may block
 *   --cookie <value>      the session cookie, without which the upgrade answers
 *                         401 (#9). A browser sends it by itself; `ws` has to be
 *                         told, which is the one thing it can do that the
 *                         browser's WebSocket cannot
 *                         (knowledge/a-browser-websocket-cannot-set-a-header.md).
 *
 * The `line` variants exist because a carriage return does not survive the trip
 * through a shell argument on every host: Git Bash drops a trailing CR from a
 * command substitution, and the keystroke silently never arrives.
 *
 * Terminal output goes to stdout unchanged, everything else to stderr: control
 * frames as `[frame] ...` and the end as `[close] code=<n> reason=<text>`.
 *
 * Exit codes: 0 every step ran, 1 a `wait` timed out, 2 bad usage, 3 the socket
 * closed before the steps were done.
 */

import { WebSocket, type RawData } from 'ws';

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 20;

type Step =
  | { kind: 'input' | 'line' | 'text' | 'textline' | 'wait'; value: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'sleep'; ms: number };

const CR = '\r';

function usage(message: string): never {
  process.stderr.write(`ws-probe: ${message}\n`);
  process.exit(2);
}

function parseStep(argument: string): Step {
  const separator = argument.indexOf(':');
  const kind = separator === -1 ? argument : argument.slice(0, separator);
  const value = separator === -1 ? '' : argument.slice(separator + 1);

  switch (kind) {
    case 'input':
    case 'line':
    case 'text':
    case 'textline':
    case 'wait':
      return { kind, value };
    case 'resize': {
      const match = /^(\d+)x(\d+)$/.exec(value);
      if (match === null) return usage(`resize needs <cols>x<rows>, got '${value}'`);
      return { kind, cols: Number(match[1]), rows: Number(match[2]) };
    }
    case 'sleep':
      return { kind, ms: Number(value) };
    default:
      return usage(`unknown step '${argument}'`);
  }
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const argv = process.argv.slice(2);
const url = argv.shift();
if (url === undefined) usage('usage: ws-probe <url> [steps...]');
// The URL is positional and comes first. Said out loud because getting it wrong
// is not obvious from the fallout: the option name becomes the URL, its value
// becomes an unknown step, and the complaint names neither.
if (url.startsWith('--')) usage(`the url comes before the options, got '${url}' first`);

let timeoutMs = DEFAULT_TIMEOUT_MS;
let cookie: string | undefined;
const steps: Step[] = [];
while (argv.length > 0) {
  const argument = argv.shift();
  if (argument === undefined) break;
  if (argument === '--timeout') {
    timeoutMs = Number(argv.shift() ?? '');
    if (!Number.isFinite(timeoutMs)) usage('--timeout needs a number of milliseconds');
    continue;
  }
  if (argument === '--cookie') {
    cookie = argv.shift();
    if (cookie === undefined || cookie === '') usage('--cookie needs a value');
    continue;
  }
  steps.push(parseStep(argument));
}

const socket = new WebSocket(url, cookie === undefined ? {} : { headers: { cookie } });
let screen = '';
let closed: { code: number; reason: string } | undefined;

socket.on('message', (data: RawData, isBinary: boolean) => {
  const text = toBuffer(data).toString('utf8');
  if (isBinary) {
    screen += text;
    process.stdout.write(text);
    return;
  }
  process.stderr.write(`[frame] ${text}\n`);
});

socket.on('close', (code: number, reason: Buffer) => {
  closed = { code, reason: reason.toString('utf8') };
  process.stderr.write(`[close] code=${code} reason=${closed.reason}\n`);
});

socket.on('error', (error: Error) => {
  process.stderr.write(`[error] ${error.message}\n`);
});

function finish(code: number): never {
  // Writes to a file are synchronous in Node, so nothing is lost here -- which
  // is why the smoke test redirects stdout and stderr to files rather than
  // piping them.
  process.exit(code);
}

async function open(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('close', () => {
      reject(new Error('closed before it opened'));
    });
  });
}

async function waitFor(needle: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!screen.includes(needle)) {
    if (closed !== undefined) {
      process.stderr.write(`[abort] socket closed while waiting for '${needle}'\n`);
      finish(3);
    }
    if (Date.now() > deadline) {
      process.stderr.write(`[timeout] never saw '${needle}'\n`);
      finish(1);
    }
    await delay(POLL_MS);
  }
}

async function run(step: Step): Promise<void> {
  switch (step.kind) {
    case 'input':
      socket.send(Buffer.from(step.value, 'utf8'));
      return;
    case 'line':
      socket.send(Buffer.from(step.value + CR, 'utf8'));
      return;
    case 'text':
      socket.send(step.value);
      return;
    case 'textline':
      socket.send(step.value + CR);
      return;
    case 'resize':
      socket.send(JSON.stringify({ type: 'resize', cols: step.cols, rows: step.rows }));
      return;
    case 'sleep':
      await delay(step.ms);
      return;
    case 'wait':
      await waitFor(step.value);
      return;
  }
}

try {
  await open();
} catch (error) {
  // A refusal is a legitimate outcome: the close line on stderr is the result
  // the caller is after, so do not turn it into a stack trace.
  process.stderr.write(`[failed] ${error instanceof Error ? error.message : String(error)}\n`);
  finish(closed === undefined ? 1 : 3);
}

for (const step of steps) {
  if (closed !== undefined) finish(3);
  await run(step);
}

if (closed === undefined) {
  socket.close();
  // The server may still be writing; give the close handshake a moment, but do
  // not hang on a peer that never answers.
  await Promise.race([new Promise((resolve) => socket.once('close', resolve)), delay(2000)]);
}
finish(0);
