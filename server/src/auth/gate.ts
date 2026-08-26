import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { readCookie, serialiseCookie } from './cookie.ts';
import { SESSION_COOKIE, type SessionAuth } from './session.ts';

/**
 * The one cross-cutting check the server has.
 *
 * Registered on the root instance rather than per plugin, because
 * @fastify/static's `prefix: '/'` wildcard and the not-found handler need it
 * too, and because "closed unless listed" is the only default worth having: a
 * route file added later is behind the check without anybody remembering.
 */

/**
 * What is reachable without a session.
 *
 * The login page *is* the SPA: one index.html plus one hashed bundle, the same
 * two files the app itself is built from, so the shell has to be public or there
 * is nothing to log in with. It carries no data and no secret -- every instance,
 * project, console and build log is behind the check -- so "the UI is unusable
 * without a login" holds: an unauthenticated browser gets a login form and
 * nothing else.
 *
 * Enumerated rather than "whatever @fastify/static would serve", so a file that
 * lands in web/dist later is closed until somebody says otherwise.
 */
const PUBLIC_SHELL = new Set(['/', '/index.html', '/favicon.ico']);
const PUBLIC_ASSETS = '/assets/';

export function isPublicPath(method: string, path: string): boolean {
  // A refusal is safe, an accidental exemption is not: nothing below has to cope
  // with `..`, so it never reaches the list.
  if (path.includes('..')) return false;

  if (method === 'POST') return path === '/login' || path === '/logout';
  if (method !== 'GET' && method !== 'HEAD') return false;

  // Readiness, not data: three harnesses gate on it (e2e's webServer.url,
  // smoke-lib.sh's wait_for_health and stop_server), and its body says only
  // whether a daemon answers.
  if (path === '/health') return true;

  return PUBLIC_SHELL.has(path) || path.startsWith(PUBLIC_ASSETS);
}

/** Query off, path only -- the exemptions are about paths. */
function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

export function sessionGate(auth: SessionAuth, secureCookie: boolean): onRequestAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicPath(request.method, pathOf(request.url))) return;

    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = token === undefined ? undefined : auth.verify(token);

    if (session === undefined) {
      // A hook that short-circuits an *upgrade* request has to hand the socket
      // back itself. Node passes an upgrade to its 'upgrade' listener and stops
      // treating it as an ordinary request, so the socket the 401 goes out on is
      // one `server.close()` waits for and `closeAllConnections()` does not
      // reach -- and the server never shuts down again. @fastify/websocket
      // destroys the socket for its own 404s; a refusal from up here is outside
      // that. See knowledge/refusing-a-websocket-upgrade-leaks-its-socket.md.
      if (request.headers.upgrade !== undefined) {
        reply.raw.on('finish', () => {
          request.raw.socket.destroy();
        });
      }

      // The same `{ error, message }` shape as every other refusal, so the web
      // client's failure() needs no special case. No WWW-Authenticate: the
      // scheme is not one a browser knows, and it would only make Chrome offer
      // a basic-auth dialog.
      //
      // On a WebSocket upgrade this is the handshake failing, which the browser
      // can only report as a 1006 close -- the SPA learns the real reason from
      // the 401 its REST call gets at the same moment.
      return reply.code(401).send({ error: 'unauthorized', message: 'log in first' });
    }

    // Sliding, and skipped for an upgrade: a 101 carries no Set-Cookie a browser
    // would keep.
    if (request.headers.upgrade === undefined && auth.shouldRenew(session)) {
      const fresh = auth.issue();
      void reply.header(
        'set-cookie',
        serialiseCookie(SESSION_COOKIE, fresh.token, {
          maxAge: Math.floor(auth.ttlMs / 1000),
          secure: secureCookie,
        }),
      );
    }
  };
}
