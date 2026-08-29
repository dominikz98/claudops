import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The credential a container proves its own identity with when it reports what
 * Claude is doing.
 *
 * One HMAC over the instance id, handed to the container as an environment
 * variable at create time. Derived rather than stored: the alternative is a
 * token column, and the database holds exactly one secret today -- a project's
 * PAT, encrypted, and only because a template outlives its instances
 * (knowledge/project-pat-encrypted-at-rest.md). A value that can be recomputed
 * from the login secret needs none of that.
 *
 * What it is for is narrow, and worth being clear about: the status endpoint is
 * the one thing an instance may reach on the host, so the token is what keeps
 * one instance from reporting another's status, and what keeps everything else
 * on the LAN from reporting any. It grants nothing else -- there is nothing
 * else on that port.
 *
 * The agent inside the container can read the variable, and could post whatever
 * status it likes about itself. That is not a hole this could close: it can
 * also edit the hook configuration, or simply not run. The badge says what the
 * instance claims it is doing, which is what the operator wants to know.
 *
 * Derived from the same shared secret as the session cookie, with its own HKDF
 * `info` -- so a session token is not a status token and neither verifies as
 * the other (server/src/auth/session.ts has the same construction).
 */

const STATUS_INFO = 'claudops.status.v1';
const KEY_BYTES = 32;

export interface StatusTokens {
  /** The token this instance's container is created with. Stable: the same
   *  instance id always derives the same token, so a container that outlives a
   *  server restart keeps reporting. */
  issue(instanceId: string): string;
  /** Constant time, and false for anything that does not decode. */
  verify(instanceId: string, token: string): boolean;
}

/**
 * `secret` is CLAUDOPS_LOGIN_SECRET. Without one -- the tests, and the
 * deliberately open mode buildApp warns about -- a random per-process key is
 * used instead, which is correct but forgetful: containers created before a
 * restart then report with a token the new process does not recognise, and say
 * so in the log rather than silently.
 */
export function createStatusTokens(secret: string | undefined): StatusTokens {
  const key =
    secret === undefined
      ? randomBytes(KEY_BYTES)
      : Buffer.from(hkdfSync('sha256', secret, '', STATUS_INFO, KEY_BYTES));

  const mac = (instanceId: string): Buffer =>
    createHmac('sha256', key).update(instanceId).digest();

  return {
    issue(instanceId: string): string {
      return mac(instanceId).toString('base64url');
    },

    verify(instanceId: string, token: string): boolean {
      const given = Buffer.from(token, 'base64url');
      const want = mac(instanceId);
      // timingSafeEqual throws on a length mismatch, and base64url decoding is
      // lenient enough that a caller can produce any length at all.
      if (given.length !== want.length) return false;
      return timingSafeEqual(given, want);
    },
  };
}
