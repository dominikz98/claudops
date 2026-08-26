import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * The login session: one HMAC over an expiry, carried in a cookie.
 *
 * Stateless on purpose. The whole session state is "valid until <t>", and a
 * signed timestamp says that without a table, a sweep, or a restart logging
 * every browser out. The price is that logout is client-side only -- a token
 * somebody copied stays valid until it expires
 * (knowledge/the-session-cookie-is-stateless.md).
 *
 * A cookie rather than a bearer token because the browser's WebSocket
 * constructor cannot set a header, so a cookie is the only credential it sends
 * on an upgrade by itself. The alternatives -- the query string, the
 * subprotocol -- would write the token into every log line, which this ticket's
 * own "no tokens in the logs" criterion forbids
 * (knowledge/a-browser-websocket-cannot-set-a-header.md).
 *
 * Hand-rolled for the same reason server/src/secrets/cipher.ts is: what is
 * needed here is one HMAC over one number, and @fastify/secure-session would
 * add a third native module to the pnpm allowlist for it.
 */

/** Name-spaced: cookies ignore the port, so anything else on this host would
 *  otherwise share the jar. */
export const SESSION_COOKIE = 'claudops_session';

/** Long enough that a working day needs one login, short enough that a
 *  forgotten tab does not stay open for a week. Renewed while in use. */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** Version prefix, so a future format change is recognisable instead of
 *  arriving as a signature failure -- the same reason cipher.ts has one. */
const VERSION = 'v1';

/** Domain separation, the HKDF equivalent of the cipher's AAD: the signing key
 *  is derived from the shared secret rather than being it, and a MAC made for
 *  the other purpose would not verify here. */
const SESSION_INFO = 'claudops.session.v1';
const COMPARE_INFO = 'claudops.login.v1';

const KEY_BYTES = 32;

export interface Session {
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface SessionAuthOptions {
  ttlMs?: number | undefined;
  /** Only the tests replace this, to age a token without waiting. */
  now?: (() => number) | undefined;
}

export interface SessionAuth {
  /** Whether what somebody typed into the login form is the shared secret.
   *  Constant time, and constant in the length of the input too. */
  matches(submitted: string): boolean;
  /** A fresh token and the moment it stops being accepted. */
  issue(): { token: string; session: Session };
  /** The session a cookie value stands for, or `undefined` for anything that
   *  does not verify, is malformed, or has expired. */
  verify(token: string): Session | undefined;
  /** True past half the lifetime: an active browser is never logged out
   *  mid-session, an idle one still expires. */
  shouldRenew(session: Session): boolean;
  readonly ttlMs: number;
}

function derive(secret: string, info: string): Buffer {
  // No salt: there is one secret and one deployment, so there is nothing to
  // separate but the two purposes -- which is what `info` does.
  return Buffer.from(hkdfSync('sha256', secret, '', info, KEY_BYTES));
}

export function createSessionAuth(secret: string, options: SessionAuthOptions = {}): SessionAuth {
  const signingKey = derive(secret, SESSION_INFO);
  const compareKey = derive(secret, COMPARE_INFO);
  const expected = createHmac('sha256', compareKey).update(secret).digest();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  const mac = (payload: string): Buffer =>
    createHmac('sha256', signingKey).update(payload).digest();

  return {
    ttlMs,

    matches(submitted: string): boolean {
      // Both sides hashed to 32 bytes first: timingSafeEqual needs equal
      // lengths, and hashing means the length of the secret cannot leak through
      // a length check either.
      const given = createHmac('sha256', compareKey).update(submitted).digest();
      return timingSafeEqual(given, expected);
    },

    issue() {
      const expiresAt = now() + ttlMs;
      // Digits in the clear rather than base64: every byte here is legal in a
      // cookie value, and a token you can read the expiry off is one you can
      // debug. The MAC is what makes it unforgeable, not obscurity.
      const payload = `${VERSION}.${String(expiresAt)}`;
      return { token: `${payload}.${mac(payload).toString('base64url')}`, session: { expiresAt } };
    },

    verify(token: string): Session | undefined {
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;

      const [version, expiry, signature] = parts;
      if (version !== VERSION || expiry === undefined || signature === undefined) return undefined;
      // Parsed strictly before it is trusted. The MAC already binds it, but a
      // `0x10` or a `1e99` reaching Number() is a bug waiting for somebody else
      // to find.
      if (!/^\d{1,15}$/.test(expiry)) return undefined;

      const given = Buffer.from(signature, 'base64url');
      const want = mac(`${version}.${expiry}`);
      if (given.length !== want.length) return undefined;
      if (!timingSafeEqual(given, want)) return undefined;

      const expiresAt = Number(expiry);
      return expiresAt > now() ? { expiresAt } : undefined;
    },

    shouldRenew(session: Session): boolean {
      return session.expiresAt - now() < ttlMs / 2;
    },
  };
}
