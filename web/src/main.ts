/** Boot: ask whether there is a session, then pick the view the hash asks for
 *  and swap it whenever the hash changes. Views clean up after themselves --
 *  see `views/view.ts`. */

import './styles.css';

import { createApi } from './api.ts';
import { navigate, onRouteChange, parseRoute, routeHash, type Route } from './router.ts';
import { mountConsole } from './views/console.ts';
import { mountList } from './views/list.ts';
import { mountLogin } from './views/login.ts';
import { mountProjects } from './views/projects.ts';
import type { View } from './views/view.ts';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('#app is missing from index.html');

// Any refusal from the session gate lands here: the SPA goes to the form rather
// than paint an error the list view's poll would repaint forever.
const api = createApi(undefined, () => {
  if (window.location.hash !== routeHash({ view: 'login' })) navigate({ view: 'login' });
});

let current: View | undefined;

// An arrow rather than a declaration: a hoisted function would be checked
// against `root` before the null guard above narrowed it.
const mount = (route: Route): View => {
  if (route.view === 'login') return mountLogin(root, api);
  if (route.view === 'list') return mountList(root, api);
  if (route.view === 'projects') return mountProjects(root, api);
  return mountConsole(root, api, route.id);
};

/** The route currently on screen, as its hash. */
let rendered: string | undefined;

const render = (route: Route): void => {
  // Idempotent: the redirect to #/login below arrives both as a hashchange and
  // as the initial render, and mounting the same view twice would leave the
  // first copy's timers running until its own destroy.
  const hash = routeHash(route);
  if (rendered === hash) return;
  rendered = hash;

  // Order matters: the outgoing view has to close its socket and stop its poll
  // before the incoming one takes the container over.
  current?.destroy();
  current = mount(route);
};

onRouteChange(render);

// Asked before the first paint, so an unauthenticated browser sees the form
// rather than the list flashing up and being replaced by it. The gate answers
// this one with 401 like any other endpoint, and the api's own handler turns
// that into the redirect -- so there is nothing to branch on here.
void api
  .session()
  .catch(() => undefined)
  .then(() => {
    render(parseRoute(window.location.hash));
  });
