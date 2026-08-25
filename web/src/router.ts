/**
 * Routing in the fragment, not in the path.
 *
 * The SPA and the REST API share one origin, so a history route
 * `/instances/<id>` would be the REST resource, not a page -- and serving the
 * SPA under it would shadow the API. Keeping routes in the hash sidesteps that
 * entirely and needs no catch-all on the server
 * (knowledge/spa-hash-routing-avoids-the-api-namespace.md).
 */

export type Route = { view: 'list' } | { view: 'console'; id: string };

const CONSOLE_PREFIX = '#/i/';

/** Anything unrecognised is the list: a mistyped hash must not leave the page
 *  blank. */
export function parseRoute(hash: string): Route {
  if (!hash.startsWith(CONSOLE_PREFIX)) return { view: 'list' };

  const id = decodeURIComponent(hash.slice(CONSOLE_PREFIX.length));
  return id === '' ? { view: 'list' } : { view: 'console', id };
}

export function routeHash(route: Route): string {
  return route.view === 'list' ? '#/' : `${CONSOLE_PREFIX}${encodeURIComponent(route.id)}`;
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

/** Returns the unsubscribe, so a caller can tear the listener down again. */
export function onRouteChange(handler: (route: Route) => void): () => void {
  const listener = (): void => {
    handler(parseRoute(window.location.hash));
  };
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}
