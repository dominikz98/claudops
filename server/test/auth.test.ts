import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { readCookie, serialiseCookie } from '../src/auth/cookie.ts';
import { isPublicPath } from '../src/auth/gate.ts';
import { createSessionAuth, SESSION_COOKIE } from '../src/auth/session.ts';
import { migrate } from '../src/db/migrations.ts';
import { FakeDockerEngine } from './fake-engine.ts';
import { testCipher } from './fixtures.ts';

const SECRET = 'a-shared-secret-long-enough';

describe('session tokens', () => {
  it('issues a token that verifies again', () => {
    const auth = createSessionAuth(SECRET);
    const { token, session } = auth.issue();

    expect(auth.verify(token)).toEqual({ expiresAt: session.expiresAt });
  });

  it('refuses a token signed with another secret', () => {
    const foreign = createSessionAuth('a-different-secret-entirely');

    expect(createSessionAuth(SECRET).verify(foreign.issue().token)).toBeUndefined();
  });

  it('refuses a tampered expiry', () => {
    const auth = createSessionAuth(SECRET);
    const [version, expiry, signature] = auth.issue().token.split('.');
    const later = String(Number(expiry) + 60_000);

    expect(auth.verify(`${String(version)}.${later}.${String(signature)}`)).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['not three parts', 'v1.123'],
    ['a wrong version', 'v2.99999999999999.aaaa'],
    ['a non-numeric expiry', 'v1.0x10.aaaa'],
    ['an exponent expiry', 'v1.1e99.aaaa'],
  ])('refuses a malformed token: %s', (_name, token) => {
    expect(createSessionAuth(SECRET).verify(token)).toBeUndefined();
  });

  it('refuses a token past its expiry', () => {
    let clock = 1_000_000;
    const auth = createSessionAuth(SECRET, { ttlMs: 1000, now: () => clock });
    const { token } = auth.issue();

    expect(auth.verify(token)).toBeDefined();
    clock += 1001;
    expect(auth.verify(token)).toBeUndefined();
  });

  it('asks for a renewal only past half the lifetime', () => {
    let clock = 1_000_000;
    const auth = createSessionAuth(SECRET, { ttlMs: 1000, now: () => clock });
    const { session } = auth.issue();

    expect(auth.shouldRenew(session)).toBe(false);
    clock += 600;
    expect(auth.shouldRenew(session)).toBe(true);
  });

  it('matches the shared secret and nothing else', () => {
    const auth = createSessionAuth(SECRET);

    expect(auth.matches(SECRET)).toBe(true);
    expect(auth.matches('')).toBe(false);
    expect(auth.matches(`${SECRET} `)).toBe(false);
    // A prefix must not match: the comparison runs over hashes, so the length
    // of the secret cannot leak through a length check either.
    expect(auth.matches(SECRET.slice(0, -1))).toBe(false);
  });

  it('keeps the secret out of the token', () => {
    expect(createSessionAuth(SECRET).issue().token).not.toContain(SECRET);
  });
});

describe('cookie helpers', () => {
  it('reads one cookie out of a header with several', () => {
    expect(readCookie(`other=1; ${SESSION_COOKIE}=abc; third=2`, SESSION_COOKIE)).toBe('abc');
  });

  it('is undefined for a missing cookie or a missing header', () => {
    expect(readCookie('other=1', SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });

  it('does not confuse a name that ends the same way', () => {
    expect(readCookie(`not_${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBeUndefined();
  });

  it('serialises the attributes the browser needs, Secure only on request', () => {
    const plain = serialiseCookie(SESSION_COOKIE, 'token', { maxAge: 60, secure: false });

    expect(plain).toBe(`${SESSION_COOKIE}=token; Max-Age=60; Path=/; HttpOnly; SameSite=Strict`);
    expect(serialiseCookie(SESSION_COOKIE, 'token', { maxAge: 60, secure: true })).toContain(
      '; Secure',
    );
  });
});

describe('the public path list', () => {
  it.each([
    ['GET', '/health'],
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/assets/main-abc123.js'],
    ['HEAD', '/'],
    ['POST', '/login'],
    ['POST', '/logout'],
  ])('lets %s %s through', (method, path) => {
    expect(isPublicPath(method, path)).toBe(true);
  });

  it.each([
    ['GET', '/instances'],
    ['GET', '/instances/abc/terminal'],
    ['GET', '/projects'],
    // The check itself: a 401 is the answer the SPA is asking for.
    ['GET', '/session'],
    ['POST', '/instances'],
    ['DELETE', '/instances/abc'],
    ['GET', '/nope'],
    // A traversal never reaches the list.
    ['GET', '/assets/../instances'],
  ])('holds %s %s back', (method, path) => {
    expect(isPublicPath(method, path)).toBe(false);
  });
});

describe('the session gate', () => {
  let app: FastifyInstance;
  let port: number;

  const login = async (secret = SECRET): Promise<string | undefined> => {
    const response = await app.inject({ method: 'POST', url: '/login', payload: { secret } });
    const header = response.headers['set-cookie'];
    return typeof header === 'string' ? header : undefined;
  };

  /** The `name=value` part, which is what a Cookie request header carries. */
  const cookieOf = (setCookie: string | undefined): string =>
    setCookie === undefined ? '' : (setCookie.split(';')[0] ?? '');

  beforeEach(async () => {
    const db = new Database(':memory:');
    migrate(db);
    app = buildApp({
      db,
      engine: new FakeDockerEngine(),
      baseImage: 'claudops-base',
      instanceEnv: {
        claudeOauthToken: undefined,
        gitUserName: undefined,
        gitUserEmail: undefined,
        firewallAllow: undefined,
      },
      cipher: testCipher(),
      auth: createSessionAuth(SECRET),
      logLevel: 'silent',
    });

    // A real socket, not app.inject: inject speaks HTTP and cannot upgrade.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  // Plain `app.close()` on purpose: a refused upgrade used to leave a socket
  // behind that no close reaches, and this hook timing out is what found it.
  // The gate destroys that socket now, so this is also the regression test for
  // it (knowledge/refusing-a-websocket-upgrade-leaks-its-socket.md).
  afterEach(async () => {
    await app.close();
  });

  it('refuses the API without a cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/instances' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized', message: 'log in first' });
  });

  it('refuses a forged cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/instances',
      headers: { cookie: `${SESSION_COOKIE}=v1.99999999999999.forged` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers an unknown route with 401 rather than 404', async () => {
    // Leaks strictly less: without a session, not even the route table shows.
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
  });

  it('leaves /health reachable, because three harnesses gate on it', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('lets the API through with the cookie the login handed out', async () => {
    const cookie = cookieOf(await login());
    const response = await app.inject({ method: 'GET', url: '/instances', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('instances');
  });

  it('runs open, with a warning, when no auth is configured', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const open = buildApp({
      db,
      engine: new FakeDockerEngine(),
      baseImage: 'claudops-base',
      instanceEnv: {
        claudeOauthToken: undefined,
        gitUserName: undefined,
        gitUserEmail: undefined,
        firewallAllow: undefined,
      },
      logLevel: 'silent',
    });

    expect((await open.inject({ method: 'GET', url: '/instances' })).statusCode).toBe(200);
    await open.close();
  });

  describe('the terminal upgrade', () => {
    /** The HTTP status the handshake ended on. `101` means it was accepted. */
    const handshake = async (cookie?: string): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/instances/x/terminal`, {
          headers: cookie === undefined ? {} : { cookie },
        });
        // `ws` emits this instead of 'error' as soon as somebody listens for it.
        socket.on('unexpected-response', (request, response) => {
          const status = response.statusCode ?? 0;
          // Both halves have to be let go of, or `app.close()` in afterEach waits
          // for a connection nobody is reading: a refused upgrade leaves an
          // ordinary HTTP response with an unread body behind.
          response.resume();
          request.destroy();
          socket.terminate();
          resolve(status);
        });
        socket.on('upgrade', () => {
          socket.terminate();
          resolve(101);
        });
        socket.on('error', (error: Error) => {
          reject(error);
        });
      });

    it('is refused with 401 before the handler runs', async () => {
      await expect(handshake()).resolves.toBe(401);
    });

    it('is refused with 401 for a forged cookie', async () => {
      await expect(handshake(`${SESSION_COOKIE}=v1.99999999999999.forged`)).resolves.toBe(401);
    });

    it('is upgraded with a valid session', async () => {
      // The instance does not exist, so the socket is closed straight after --
      // but the handshake itself has to succeed, which is what this asserts.
      await expect(handshake(cookieOf(await login()))).resolves.toBe(101);
    });
  });
});

describe('the login endpoints', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    const db = new Database(':memory:');
    migrate(db);
    app = buildApp({
      db,
      engine: new FakeDockerEngine(),
      baseImage: 'claudops-base',
      instanceEnv: {
        claudeOauthToken: undefined,
        gitUserName: undefined,
        gitUserEmail: undefined,
        firewallAllow: undefined,
      },
      auth: createSessionAuth(SECRET),
      logLevel: 'silent',
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers the right secret with a session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { secret: SECRET },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: true });
    expect(response.headers['set-cookie']).toContain(`${SESSION_COOKIE}=`);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
  });

  it('answers a wrong secret with 401 and no cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { secret: 'wrong-but-long-enough' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'invalid_secret' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a body that is not a secret at all', async () => {
    const response = await app.inject({ method: 'POST', url: '/login', payload: { nope: 1 } });

    expect(response.statusCode).toBe(400);
  });

  it('never echoes the secret back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { secret: SECRET },
    });

    expect(response.body).not.toContain(SECRET);
    expect(response.headers['set-cookie']).not.toContain(SECRET);
  });

  it('brakes after ten wrong guesses from one address', async () => {
    const guess = async (): Promise<number> =>
      (
        await app.inject({
          method: 'POST',
          url: '/login',
          payload: { secret: 'wrong-but-long-enough' },
        })
      ).statusCode;

    for (let attempt = 0; attempt < 10; attempt += 1) expect(await guess()).toBe(401);

    const braked = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { secret: 'wrong-but-long-enough' },
    });
    expect(braked.statusCode).toBe(429);
    expect(braked.headers['retry-after']).toBeDefined();

    // The brake is per address, not per secret: even the right one waits.
    const correct = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { secret: SECRET },
    });
    expect(correct.statusCode).toBe(429);
  });

  it('clears the cookie on logout, without needing a valid one', async () => {
    const response = await app.inject({ method: 'POST', url: '/logout' });

    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('reports the session behind the gate', async () => {
    const login = await app.inject({ method: 'POST', url: '/login', payload: { secret: SECRET } });
    const header = login.headers['set-cookie'];
    const cookie = (typeof header === 'string' ? header : '').split(';')[0] ?? '';

    expect((await app.inject({ method: 'GET', url: '/session' })).statusCode).toBe(401);

    const session = await app.inject({ method: 'GET', url: '/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true });
  });
});
