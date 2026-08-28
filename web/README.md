# `@claudops/web`

The browser side of claudops: the projects page, the instance list and one
xterm.js console per instance. Built with Vite into `dist/`, from where the server
serves it on its own port -- there is no second process and no second origin.

Plain TypeScript, no framework. There are four views, and the only real
dependency is `@xterm/xterm` with its fit addon.

## Run

Against a server that is already up:

```bash
CLAUDOPS_LOGIN_SECRET=a-shared-secret-long-enough pnpm --filter @claudops/server dev
pnpm dev:web                           # :5173, proxies the API and the login
```

The dev server proxies the API *and* the terminal upgrade (`ws: true`), so the
console works there too. `CLAUDOPS_DEV_SERVER` points the proxy somewhere else,
for instance at the NUC. `/login`, `/logout` and `/session` are in the proxy map
as well -- without them the page can be loaded but not logged into.

The server refuses to start without `CLAUDOPS_LOGIN_SECRET`, and the first thing
the page shows is the form asking for it.

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
| `#/login` | The shared-secret form. Where the app sends you whenever any request comes back `unauthorized`, whichever page you were on. |
| `#/` | Instance list: create from a project, status, delete, log out. Polls `GET /instances` every 3 s. |
| `#/projects` | Projects: create, edit, delete the templates instances come from, and watch their images being built. Polls only while a build is running. |
| `#/i/<id>` | The console of one instance, over `GET /instances/<id>/terminal`, with **Attach** for files. |

Routes live in the hash on purpose: `/instances/<id>` and `/projects` are already
REST resources, so a history route would collide with them.

Deleting asks twice -- the first click turns the button into "Really delete?" --
because a delete takes the container and everything uncommitted in it. A project
whose instances still exist cannot be deleted at all; the banner shows what the
server said.

The instance form is a name and a project picker: repository, branch, credential
and environment belong to the project. A project whose image is not `ready` is
offered but disabled, with its state in the option text -- the server would answer
`422`, and reading why in the picker beats reading it in a banner. With no usable
project the Create button is off and the hint below says which of the two problems
it is.

The projects page shows each project's image as a badge -- `queued`, `building`,
`ready`, `failed` -- with **Rebuild** and **Build log** next to it; the log opens
in a row of its own, fetched from `GET /projects/:id/build-log` rather than carried
in the list, because it runs to tens of kilobytes. This page deliberately does not
poll, since nothing but this page changes a project -- except while an image is
being built, which is the server changing it, so then it refreshes every two
seconds and stops again when the last build is done.

The git token field is a password input on the projects page, is never sent back
by the server, and is left empty when a project is opened for editing -- an empty
field means "keep the stored token", and removing it is its own button.

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

## Attachments

Three ways to hand the instance a file, all of them one `POST` per file with
the bytes as the body: the **Attach** button, a drop on the terminal, and a
paste that carries files rather than text. The paste listener sits on the screen
element in the capture phase and only takes over when `clipboardData.files` is
non-empty -- a text paste has to reach xterm untouched, because that is where
bracketed paste comes from.

A clipboard image is called `image.png` in every browser and on every paste, so
`src/upload.ts` gives it a timestamped name of its own; without that a second
screenshot would overwrite the first inside the container. Several files go up
one after the other rather than at once, because the server types each path into
the prompt and parallel uploads would interleave them.

The status line next to the console header shows the path the server settled on,
or the server's error -- there is no size check in the browser: the limit is
configurable on the server, and a second copy of that number here would be wrong
after the first change to it.

## Structure

```
src/main.ts               boot and route dispatch
src/router.ts             hash routes
src/api.ts                the REST client, with an injectable fetch
src/terminal/session.ts   the WebSocket: frames, close codes, geometry
src/views/list.ts         instance list and create form
src/views/projects.ts     projects: form, edit mode, table, image state and build log
src/views/console.ts      xterm.js, fit addon, status line, attachments
src/upload.ts             names for the files that arrive without one
src/dom.ts                the three lines of DOM plumbing the views share
```

## Test

```bash
pnpm --filter @claudops/web test    # vitest, the DOM-free logic
./e2e/run.sh                        # the pages themselves, in a real browser
```

The unit tests cover the parts worth asserting without a DOM: the API client, the
routes, the terminal URL, the close-code messages and the naming of a pasted
file. Everything that needs a
browser is in [`e2e/`](../e2e/run.sh), where it runs against a real server and a
real container.
