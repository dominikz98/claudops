import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import { readCookie, serialiseCookie } from './cookie.ts';
import { SESSION_COOKIE, type SessionAuth } from './session.ts';

/**
 * `minLength: 1`, not the 16 the configuration insists on: a short guess is a
 * wrong secret, not a malformed request, and answering it differently would tell
 * somebody where the boundary is. The cap bounds the work per attempt.
 */
const loginBodySchema = {
  type: 'object',
  required: ['secret'],
  additionalProperties: false,
  properties: { secret: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

/**
 * A shared secret has no lockout to fall back on -- there is no account to lock
 * -- so the only brake is per-address and time-boxed. Ten wrong guesses a minute
 * is invisible to somebody who mistyped and useless to a script; the real
 * defence is the length the configuration demands.
 */
const MAX_FAILURES = 10;
const WINDOW_MS = 60_000;

/** A bound on the map: on a LAN `request.ip` is real, but an unbounded cache
 *  that grows per address is still an unbounded cache. */
const MAX_TRACKED = 256;

export interface AuthRoutesOptions extends FastifyPluginOptions {
  auth: SessionAuth;
  secureCookie: boolean;
}

export const authRoutes: FastifyPluginCallback<AuthRoutesOptions> = (app, options, done) => {
  const { auth, secureCookie } = options;
  const failures = new Map<string, { count: number; until: number }>();

  const cookie = (value: string, maxAge: number): string =>
    serialiseCookie(SESSION_COOKIE, value, { maxAge, secure: secureCookie });

  /** Seconds to wait, or 0 when this address may try. */
  const blocked = (ip: string, now: number): number => {
    const entry = failures.get(ip);
    if (entry === undefined || entry.until <= now) {
      failures.delete(ip);
      return 0;
    }
    return entry.count >= MAX_FAILURES ? Math.ceil((entry.until - now) / 1000) : 0;
  };

  const recordFailure = (ip: string, now: number): void => {
    if (failures.size >= MAX_TRACKED) {
      for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key);
    }

    const entry = failures.get(ip);
    if (entry === undefined || entry.until <= now) {
      failures.set(ip, { count: 1, until: now + WINDOW_MS });
      return;
    }
    entry.count += 1;
  };

  app.post<{ Body: { secret: string } }>(
    '/login',
    { schema: { body: loginBodySchema } },
    async (request, reply) => {
      const now = Date.now();

      const retryAfter = blocked(request.ip, now);
      if (retryAfter > 0) {
        request.log.warn({ ip: request.ip }, 'login rate limit hit');
        return reply.code(429).header('retry-after', String(retryAfter)).send({
          error: 'too_many_attempts',
          message: `too many failed logins -- try again in ${String(retryAfter)}s`,
        });
      }

      if (!auth.matches(request.body.secret)) {
        recordFailure(request.ip, now);
        // The address, never the attempt: what was typed is a guess at the
        // secret and belongs in no log line.
        request.log.warn({ ip: request.ip }, 'login refused');
        return reply
          .code(401)
          .send({ error: 'invalid_secret', message: 'that is not the shared secret' });
      }

      failures.delete(request.ip);
      const issued = auth.issue();
      return reply
        .header('set-cookie', cookie(issued.token, Math.floor(auth.ttlMs / 1000)))
        .send({ authenticated: true, expiresAt: new Date(issued.session.expiresAt).toISOString() });
    },
  );

  /** Public, so a cookie that no longer verifies can still be cleared. The token
   *  itself stays valid until it expires -- there is no store to revoke it in
   *  (knowledge/the-session-cookie-is-stateless.md). */
  app.post('/logout', async (_request, reply) =>
    reply.code(204).header('set-cookie', cookie('', 0)).send(),
  );

  /** Behind the gate, so the answer is the status: 200 with a session, 401
   *  without one. That is what the SPA asks before it paints anything.
   *
   *  Not async: there is nothing to await, and Fastify would only have to wrap
   *  the object in a promise to unwrap it again. */
  app.get('/session', (request) => {
    // The gate already verified it; re-read only for the expiry it reports.
    const token = readCookie(request.headers.cookie, SESSION_COOKIE) ?? '';
    const session = auth.verify(token);
    return {
      authenticated: true,
      expiresAt: session === undefined ? null : new Date(session.expiresAt).toISOString(),
    };
  });

  done();
};
