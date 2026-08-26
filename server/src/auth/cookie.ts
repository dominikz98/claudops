/**
 * Reading and writing one cookie by hand.
 *
 * @fastify/cookie would do this and nothing else that is needed here, and it is
 * not in the tree. `request.headers.cookie` and a `set-cookie` header are the
 * whole interface.
 */

export interface CookieOptions {
  /** Seconds. `0` is the deletion. */
  maxAge: number;
  /** Only with TLS in front: a browser drops a `Secure` cookie that arrived
   *  over plain http, and the login would fail without saying why. */
  secure: boolean;
}

/**
 * First match wins, and the value is taken raw. No decodeURIComponent: the token
 * has no character that needs encoding, and decoding would let a `%` sequence in
 * a hostile cookie change the bytes that get compared.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    return part.slice(equals + 1).trim();
  }
  return undefined;
}

/**
 * `HttpOnly`, because nothing in the SPA needs to read it and an XSS should not
 * get it either -- the page learns whether it is logged in from `GET /session`.
 * `SameSite=Strict`, because the only caller is the page the server itself
 * serves. `Path=/`, because `/instances/<id>/terminal` has to receive it too. No
 * `Domain`, so it stays host-only.
 */
export function serialiseCookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [
    `${name}=${value}`,
    `Max-Age=${String(options.maxAge)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}
