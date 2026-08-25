# `@claudops/web`

The browser side of claudops: the instance list and one xterm.js console per
instance. Built with Vite into `dist/`, from where the server serves it on its
own port -- there is no second process and no second origin.

Plain TypeScript, no framework. There are two views, and the only real
dependency is `@xterm/xterm` with its fit addon.

## Run

Against a server that is already up:

```bash
pnpm --filter @claudops/server dev     # :8080
pnpm dev:web                           # :5173, proxies /instances and /health
```

The dev server proxies the API *and* the terminal upgrade (`ws: true`), so the
console works there too. `CLAUDOPS_DEV_SERVER` points the proxy somewhere else,
for instance at the NUC.

For the real thing, build it and let the server hand it out:

```bash
pnpm build                             # server and UI
node server/dist/index.js              # http://localhost:8080
```

The server looks for the build in `../../web/dist` relative to its own location;
`CLAUDOPS_WEB_ROOT` overrides that. A missing build is not fatal -- the server
logs a warning and serves the API only.

## What the pages do

| Route | Page |
| --- | --- |
| `#/` | Instance list: create, status, delete. Polls `GET /instances` every 3 s. |
| `#/i/<id>` | The console of one instance, over `GET /instances/<id>/terminal`. |

Routes live in the hash on purpose: `/instances/<id>` is already the REST
resource, so a history route would collide with it.

Deleting asks twice -- the first click turns the button into "Really delete?" --
because a delete takes the container and everything uncommitted in it.

The git token field is a password input, is never stored, and is cleared as soon
as the request returns.

## Console details

The connect URL carries `?cols=&rows=` from the already-fitted terminal, so the
first redraw arrives in the right geometry instead of painting at 80x24 and
reflowing. Resizing the window sends a resize control message; tmux applies it to
the pane.

The status line is the diagnosis: `connected · 148×39` names the geometry the
container is being told about, `disconnected · <reason>` names the close code in
words. Nothing reconnects by itself -- reload the page, or use the button.

There is no scrollback and no session state in this package. Both live in the
container's tmux session, which is why a reload finds the console where it was.

## Structure

```
src/main.ts               boot and route dispatch
src/router.ts             hash routes
src/api.ts                the REST client, with an injectable fetch
src/terminal/session.ts   the WebSocket: frames, close codes, geometry
src/views/list.ts         instance list and create form
src/views/console.ts      xterm.js, fit addon, status line
src/dom.ts                the three lines of DOM plumbing both views share
```

## Test

```bash
pnpm --filter @claudops/web test    # vitest, the DOM-free logic
./e2e/run.sh                        # the pages themselves, in a real browser
```

The unit tests cover the parts worth asserting without a DOM: the API client, the
routes, the terminal URL and the close-code messages. Everything that needs a
browser is in [`e2e/`](../e2e/run.sh), where it runs against a real server and a
real container.
