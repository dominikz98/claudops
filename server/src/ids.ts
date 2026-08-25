import { randomBytes } from 'node:crypto';

/** Short, URL-safe and still unique enough for a handful of containers. Shared
 *  by instances and projects so both read the same way in a URL and in
 *  `docker ps`. */
export function shortId(): string {
  return randomBytes(6).toString('hex');
}
