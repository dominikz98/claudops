import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrations.ts';
import { TerminalClose } from '../src/terminal/protocol.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { createTestProject, testCipher } from './fixtures.ts';

interface Closed {
  code: number;
  reason: string;
}

/** One browser tab: the frames it received, split the way the protocol splits
 *  them, and the close it ends on. */
interface Client {
  socket: WebSocket;
  /** Terminal output, concatenated as text -- the tests only send ASCII. */
  screen: () => string;
  /** JSON control frames, as they arrived. */
  notices: string[];
  closed: Promise<Closed>;
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

describe('terminal bridge over WebSocket', () => {
  let app: FastifyInstance;
  let engine: FakeDockerEngine;
  let port: number;

  beforeEach(async () => {
    const db = new Database(':memory:');
    migrate(db);
    engine = new FakeDockerEngine();
    app = buildApp({
      db,
      engine,
      baseImage: 'claudops-base',
      instanceEnv: {
        claudeOauthToken: 'oauth-token',
        gitUserName: undefined,
        gitUserEmail: undefined,
      },
      cipher: testCipher(),
      logLevel: 'silent',
      // Fast enough to see several heartbeats inside a test, slow enough not to
      // flood the socket.
      terminalBridge: { heartbeatMs: 25 },
    });

    // A real socket, not app.inject: inject speaks HTTP and cannot upgrade.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    await app.close();
  });

  const createInstance = async (): Promise<{ id: string; containerId: string }> => {
    // An instance comes from a project now, so the console needs one too.
    const projectId = await createTestProject(app);
    const response = await app.inject({
      method: 'POST',
      url: '/instances',
      payload: { name: 'demo', projectId },
    });
    return response.json<{ id: string; containerId: string }>();
  };

  const connect = async (path: string): Promise<Client> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const output: Buffer[] = [];
    const notices: string[] = [];

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) output.push(toBuffer(data));
      else notices.push(toBuffer(data).toString('utf8'));
    });

    const closed = new Promise<Closed>((resolve) => {
      socket.on('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString('utf8') }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => {
        resolve();
      });
      socket.on('error', reject);
    });

    return { socket, screen: () => Buffer.concat(output).toString('utf8'), notices, closed };
  };

  const terminal = async (path: string): Promise<Client> => {
    const client = await connect(path);
    // The attach happens after the upgrade, so wait for the session to exist
    // before poking at it.
    await expect.poll(() => engine.terminals.length).toBeGreaterThan(0);
    return client;
  };

  it('pipes container output to the browser', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    engine.lastTerminal().stream.output('claude> ready\r\n');

    await expect.poll(() => client.screen()).toContain('claude> ready');
    client.socket.close();
  });

  it('keeps piping after the first frame', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);
    const session = engine.lastTerminal();

    // The bridge pauses the stream per frame and resumes on the send callback.
    // One chunk proves nothing -- a resume that never happens looks exactly
    // like a working console until the second redraw.
    for (let line = 0; line < 50; line += 1) {
      session.stream.output(`line-${line}\r\n`);
    }

    await expect.poll(() => client.screen()).toContain('line-49');
    expect(client.screen()).toContain('line-0');
    client.socket.close();
  });

  it('pipes binary keystrokes into the container', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    client.socket.send(Buffer.from('ls -la\r', 'utf8'));

    await expect.poll(() => engine.lastTerminal().stream.input).toBe('ls -la\r');
    client.socket.close();
  });

  it('takes a text frame as keystrokes, which is what makes wscat a test client', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    client.socket.send('echo hello\r');

    await expect.poll(() => engine.lastTerminal().stream.input).toBe('echo hello\r');
    client.socket.close();
  });

  it('keeps a frame the client sends the moment the socket opens', async () => {
    const { id } = await createInstance();
    // The upgrade finishes before the attach does; a browser sends its geometry
    // in the `open` handler, which lands in exactly that gap.
    engine.attachDelayMs = 60;

    const client = await connect(`/instances/${id}/terminal`);
    client.socket.send(JSON.stringify({ type: 'resize', cols: 111, rows: 33 }));

    await expect.poll(() => engine.terminals.length).toBe(1);
    await expect.poll(() => engine.lastTerminal().resizes).toEqual([{ cols: 111, rows: 33 }]);
    client.socket.close();
  });

  it('forwards a resize to the exec instead of typing it', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    client.socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

    await expect.poll(() => engine.lastTerminal().resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(engine.lastTerminal().stream.input).toBe('');
    client.socket.close();
  });

  it('answers a broken control message and keeps the console open', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    client.socket.send(JSON.stringify({ type: 'resize', cols: 0, rows: 0 }));

    await expect.poll(() => client.notices.length).toBe(1);
    expect(JSON.parse(client.notices[0] ?? '{}')).toMatchObject({
      type: 'error',
      code: 'invalid_message',
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    // Still usable afterwards.
    client.socket.send(Buffer.from('x', 'utf8'));
    await expect.poll(() => engine.lastTerminal().stream.input).toBe('x');
    client.socket.close();
  });

  it('takes the initial geometry from the connect URL', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal?cols=100&rows=30`);

    expect(engine.lastTerminal().options.size).toEqual({ cols: 100, rows: 30 });
    client.socket.close();
  });

  it('ignores a nonsense geometry instead of refusing the connection', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal?cols=wide&rows=tall`);

    expect(engine.lastTerminal().options.size).toBeUndefined();
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
  });

  it('ends the exec when the browser goes away', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);
    const session = engine.lastTerminal();

    client.socket.close();

    // Without this the tmux client stays attached and keeps sizing the pane.
    await expect.poll(() => session.closed).toBe(true);
  });

  it('closes cleanly when the session itself ends', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    engine.lastTerminal().end(0);

    expect(await client.closed).toMatchObject({ code: TerminalClose.sessionEnded });
  });

  it('reports a non-zero exit -- what a missing tmux session looks like', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    engine.lastTerminal().end(1);

    expect(await client.closed).toMatchObject({ code: TerminalClose.conflict });
    expect(JSON.parse(client.notices[0] ?? '{}')).toMatchObject({ code: 'session_failed' });
  });

  it('refuses an unknown instance', async () => {
    const client = await connect('/instances/does-not-exist/terminal');

    expect(await client.closed).toMatchObject({ code: TerminalClose.notFound });
    expect(JSON.parse(client.notices[0] ?? '{}')).toMatchObject({ code: 'not_found' });
    expect(engine.terminals).toHaveLength(0);
  });

  it('refuses a stopped container', async () => {
    const { id, containerId } = await createInstance();
    engine.setState(containerId, 'exited');

    const client = await connect(`/instances/${id}/terminal`);

    expect(await client.closed).toMatchObject({ code: TerminalClose.conflict });
    expect(JSON.parse(client.notices[0] ?? '{}')).toMatchObject({ code: 'not_running' });
  });

  it('refuses an instance whose container is gone', async () => {
    const { id, containerId } = await createInstance();
    engine.forget(containerId);

    const client = await connect(`/instances/${id}/terminal`);

    expect(await client.closed).toMatchObject({ code: TerminalClose.conflict });
    expect(JSON.parse(client.notices[0] ?? '{}')).toMatchObject({ code: 'no_container' });
  });

  it('refuses while the Docker daemon is unreachable', async () => {
    const { id } = await createInstance();
    engine.unavailable = true;

    const client = await connect(`/instances/${id}/terminal`);

    expect(await client.closed).toMatchObject({ code: TerminalClose.dockerUnavailable });
  });

  it('keeps a live connection through several heartbeats', async () => {
    const { id } = await createInstance();
    const client = await terminal(`/instances/${id}/terminal`);

    // heartbeatMs is 25 here: a client that answers the pings survives, one
    // that stopped answering would have been terminated by now.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    engine.lastTerminal().stream.output('still here');
    await expect.poll(() => client.screen()).toContain('still here');
    client.socket.close();
  });

  it('gives a reconnect its own exec while the session keeps running', async () => {
    const { id } = await createInstance();
    const first = await terminal(`/instances/${id}/terminal`);
    const firstSession = engine.lastTerminal();

    first.socket.close();
    await expect.poll(() => firstSession.closed).toBe(true);

    const second = await connect(`/instances/${id}/terminal`);
    await expect.poll(() => engine.terminals.length).toBe(2);

    // Nothing was replayed by the server -- the second attach is a fresh exec
    // against the same tmux session, which is where the scrollback lives.
    expect(engine.lastTerminal()).not.toBe(firstSession);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    second.socket.close();
  });
});
