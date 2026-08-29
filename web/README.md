# `@claudops/web`

The browser side of claudops: the projects page, the instance list, one
xterm.js console per instance and a panel beside it showing what the instance
produced. Built with Vite into `dist/`, from where the server serves it on its
own port -- there is no second process and no second origin.

Plain TypeScript, no framework. There are four views, and the only real
dependency is `@xterm/xterm` with its fit and web-links addons.

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
| `#/` | Instance list: create from a project, status, model and effort, delete, log out. Polls `GET /instances` every 3 s -- and holds off on repainting the table while a dropdown in it has the focus, because rebuilding the rows underneath an open one closes it. |
| | The Status column carries up to three things: the Docker state, whether the session is attachable, and -- once it is -- what Claude is doing (`idle`, `running`, `needs input`, `done`). |
| `#/projects` | Projects: create, edit, delete the templates instances come from, and watch their images being built. Polls only while a build is running. |
| `#/i/<id>` | The console of one instance, over `GET /instances/<id>/terminal`, with **Attach** for files in and **Files** for files out. |

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

**Alerts** in the header turns the switch to `needs input` into a browser
notification. It is behind a click because a permission prompt has to come from
one, and it fires on the *switch* rather than on the state, so an instance that
is still waiting at the next poll is not announced again. The page's own title
counts the waiting instances regardless: the Notifications API needs a secure
context and claudops is normally reached over plain http, where it does not exist
at all -- then the button says `Alerts n/a` and the count in the tab is the whole
mechanism.

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

URLs in the output are clickable: the web-links addon turns an artefact path or
a pull-request link a run prints into a link, instead of something that has to
be selected out of a terminal by hand.

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

## The files panel

**Files** in the console header opens `src/views/files.ts` next to the terminal,
in the same flex row -- so the terminal gets narrower and reflows rather than
being replaced. It is mounted on the first open, not with the page: an operator
who only wants the console should not cost the instance a directory listing.

One request per open folder, never a tree: the workspace holds a clone with its
`node_modules`. Open folders are remembered, so **Refresh** and an upload
re-read them instead of collapsing back to the root.

What a file becomes is decided by the `content-type` the server sent, not by the
extension -- the server had the bytes in front of it and this side did not. An
image is shown from the blob that was just fetched (an object URL, revoked when
the next one replaces it) rather than from a second request for the same URL;
`text/plain` with a Markdown name goes through `src/markdown.ts`; other text is
a `<pre>`; anything else is the **Download** link alone.

`src/markdown.ts` is deliberately not a dependency. It escapes every character
*first* and only then applies its rules, so no markup in the file can become an
element -- the text comes out of a container, and this page has the operator's
session. It writes the only `innerHTML` in this package, and link targets go
through a scheme allowlist rather than a `javascript:` blocklist.

## Structure

```
src/main.ts               boot and route dispatch
src/router.ts             hash routes
src/api.ts                the REST client, with an injectable fetch
src/terminal/session.ts   the WebSocket: frames, close codes, geometry
src/views/list.ts         instance list and create form
src/notify.ts             when an instance starts waiting: the notification and the tab count
src/views/projects.ts     projects: form, edit mode, table, image state and build log
src/views/console.ts      xterm.js, fit and web-links addons, status line, attachments
src/views/files.ts        the files panel: tree, preview, download
src/markdown.ts           the small, escape-first Markdown renderer the panel uses
src/upload.ts             names for the files that arrive without one
src/dom.ts                the three lines of DOM plumbing the views share
```

## Test

```bash
pnpm --filter @claudops/web test    # vitest, the DOM-free logic
./e2e/run.sh                        # the pages themselves, in a real browser
```

The unit tests cover the parts worth asserting without a DOM: the API client, the
routes, the terminal URL, the close-code messages, the naming of a pasted file
and the Markdown renderer -- that last one including what it must *not* render.
Everything that needs a
browser is in [`e2e/`](../e2e/run.sh), where it runs against a real server and a
real container.
