/** Boot: pick the view the hash asks for, and swap it whenever the hash
 *  changes. Views clean up after themselves -- see `views/view.ts`. */

import './styles.css';

import { createApi } from './api.ts';
import { onRouteChange, parseRoute, type Route } from './router.ts';
import { mountConsole } from './views/console.ts';
import { mountList } from './views/list.ts';
import type { View } from './views/view.ts';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('#app is missing from index.html');

const api = createApi();
let current: View | undefined;

// An arrow rather than a declaration: a hoisted function would be checked
// against `root` before the null guard above narrowed it.
const render = (route: Route): void => {
  // Order matters: the outgoing view has to close its socket and stop its poll
  // before the incoming one takes the container over.
  current?.destroy();
  current = route.view === 'list' ? mountList(root, api) : mountConsole(root, api, route.id);
};

onRouteChange(render);
render(parseRoute(window.location.hash));
