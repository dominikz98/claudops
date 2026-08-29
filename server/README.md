# `@claudops/server`

Fastify server that starts Claude Code instances as Docker containers, keeps
their metadata in SQLite, mirrors their consoles over a WebSocket and serves the
web UI -- all on one port.

## Run

```bash
pnpm install
pnpm --filter @claudops/server dev     # tsx watch, reloads on change
```

Or the built server, which is what runs on the NUC:

```bash
pnpm build
node server/dist/index.js
```

The base image has to exist before an instance can start:

```bash
docker build -t claudops-base docker/base
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | The web UI, from `CLAUDOPS_WEB_ROOT`. See [Web UI](#web-ui). |
| `GET` | `/health` | Readiness: `200` when the Docker daemon answers, `503` when it does not. |
| `POST` | `/projects` | Create a project. Body: `name`, `repoUrl` (both required), `repoBranch`, `gitToken`, `buildingBlocks`. Answers `201`. |
| `GET` | `/projects` | All projects, each with `hasGitToken` and `instanceCount`. |
| `GET` | `/projects/:id` | One project. `404` if unknown. |
| `PATCH` | `/projects/:id` | Change a project. Every field optional; see [Projects](#projects). |
| `POST` | `/projects/:id/build` | Rebuild the project image. Answers `202` -- the build runs afterwards. |
| `GET` | `/projects/:id/build-log` | `{ status, builtAt, log }` of the last build. |
| `DELETE` | `/projects/:id` | Remove a project and its image. `204`, `404` if unknown, `409` while instances point at it. |
| `POST` | `/instances` | Start an instance from a project. Body: `name`, `projectId` (both required), `model` and `effort` (optional). Answers `201` with the instance. |
| `GET` | `/instances` | All instances, each with the status Docker reports, whether its session is attachable, and what Claude is doing in it. |
| `GET` | `/instances/:id` | One instance. `404` if unknown. |
| `PATCH` | `/instances/:id` | Change the model, the effort level, or both, on a running instance. `409` when there is no session to type into; see [Model and effort](#model-and-effort). |
| `POST` | `/instances/:id/stop` | Stop the container, keep the instance. Answers `200` with its new status. |
| `POST` | `/instances/:id/start` | Start it again. `200`, `409` when the instance has no container. |
| `DELETE` | `/instances/:id` | Remove the container, its volumes and the instance. `204`, or `404` if unknown. |
| `POST` | `/instances/:id/files` | Attach one file. Bytes as the body, name in `?name=`. Answers `201`. See [Attachments](#attachments). |
| `GET` | `/instances/:id/files` | One directory of the instance's workspace, one level deep. `?path=` defaults to `/workspace`. See [Files](#files). |
| `GET` | `/instances/:id/files/content` | The bytes of one file. `?path=` is required, `?download=1` forces a Save as. |
| `GET` | `/instances/:id/terminal` | WebSocket: the instance console. See [Terminal](#terminal). |

One route is deliberately not on this port. `POST /instances/:id/status` lives on
`CLAUDOPS_STATUS_PORT` and takes the hook reports of an instance container,
authenticated with that instance's own token -- see
[Activity](#instance-lifecycle). It is the only thing an instance may reach on
the host, which is why it is not next to the login.

A project first, then an instance from it -- the answer to the first call carries
the `id` the second one needs:

```bash
curl -s localhost:8080/projects \
  -H 'content-type: application/json' \
  -d '{"name":"claudops","repoUrl":"https://github.com/dominikz98/claudops.git","repoBranch":"main"}'
```

```bash
curl -s localhost:8080/instances \
  -H 'content-type: application/json' \
  -d '{"name":"demo","projectId":"<project id>"}'
```

Status codes worth knowing: `400` for a body that fails validation -- including
an unknown field, which is rejected rather than dropped -- `409` for a duplicate
project name, a project still in use, or an instance whose container is gone or
is not running, `413` for an attachment over one of the two upload limits,
`422` when the referenced project does not exist or its image is not ready,
`503` while the Docker daemon is unreachable.

## Projects

A project is the template an instance is created from: repository, branch,
environment building blocks and the PAT for a private repository. `POST
/instances` takes nothing but a `name` and a `projectId` -- an old caller sending
`repoUrl` or `gitToken` gets a `400` rather than a silently ignored field.

```json
{
  "name": "claudops",
  "repoUrl": "https://github.com/dominikz98/claudops.git",
  "repoBranch": "main",
  "gitToken": "ghp_…",
  "buildingBlocks": { "dotnet": true, "playwright": false }
}
```

`buildingBlocks` become the project's image -- see [Project images](#project-images).

The PAT is write-only. It is encrypted with `CLAUDOPS_SECRET_KEY` before it is
stored, and no response ever carries it -- a project reports `hasGitToken`
instead. Without a key the server still runs, but a request carrying a `gitToken`
answers `422 secret_key_missing`; a project whose PAT no longer decrypts (a
rotated key) fails instance creation with `422 secret_undecryptable`.

`PATCH` sends only what changes. A field that is not in the body keeps its stored
value -- which is what makes an untouched password field leave the PAT alone --
and `null` removes it:

```bash
curl -s -X PATCH localhost:8080/projects/<id> \
  -H 'content-type: application/json' \
  -d '{"repoBranch":"develop","gitToken":null}'
```

An instance keeps a snapshot of the repository and branch it was started with, so
editing a project afterwards does not rewrite what a running instance was told to
clone. Deleting a project answers `409 project_in_use` for as long as any instance
references it, running or exited -- the message says how many.

## Project images

A project's environment is a prebuilt image, `claudops-project-<id>`: the template
in [`docker/project`](../docker/project/README.md) on top of
`CLAUDOPS_BASE_IMAGE`, with one layer per building block. Instances start from it,
never from the base image.

Builds are asynchronous. `POST /projects` answers `201` right away with

```json
{ "image": { "tag": "claudops-project-a1b2c3", "status": "pending", "builtAt": null } }
```

and the build happens behind it -- a dotnet SDK plus a Chromium takes minutes, and
no HTTP request should hold that open. The four states:

| Status | Meaning |
| --- | --- |
| `pending` | Queued: a fresh project, changed building blocks, or a rebuild somebody asked for. |
| `building` | A build is running. Builds run one at a time. |
| `ready` | The image exists. The only state `POST /instances` accepts. |
| `failed` | The build did not work. The build log says why. |

`POST /instances` against anything but `ready` answers
`422 project_image_not_ready` and carries the status, because there is nothing to
fall back to -- the environment is prebuilt, not installed at container start. A
project that reports `ready` but whose tag somebody removed with `docker rmi`
fails with `422 image_not_found` instead: what exists is still Docker's answer,
not the database's.

Changing the building blocks invalidates the image and starts a rebuild. Renaming
a project or replacing its PAT does not -- neither changes the image, and the tag
follows the id rather than the name. Deleting a project removes its image too,
best effort: a tag that could not be removed is logged rather than turned into a
failed delete.

An explicit rebuild, which is also the only way out of `failed` -- no build clears
that on its own, so a broken Dockerfile is not retried in a loop:

```bash
curl -s -X POST localhost:8080/projects/<id>/build
curl -s localhost:8080/projects/<id>/build-log
```

The log is written away while the build runs, at most once a second, so a build in
flight answers with a log that grows rather than with nothing until it ends. It is
capped at the last 64 KiB, with a line saying what was dropped: the tail is where
the failing step is, and the database is not a log server. A rebuild clears the
previous log when it puts the image back to `pending`, so what is readable always
belongs to the build the status names.

On startup the server picks up what a restart interrupted: a project still marked
`building` is a leftover -- no build survives the process that ran it -- and goes
back into the queue, together with everything still `pending`. That is also what
builds the images of projects created before this existed.

## Instance lifecycle

An instance is a container, and the server treats it as disposable -- but not as
unbounded and not as something that may be left lying around.

**Limits.** Every container is created with a CPU and a memory ceiling,
`CLAUDOPS_INSTANCE_CPUS` and `CLAUDOPS_INSTANCE_MEMORY`, by default two cores and
four gigabytes. Swap is capped at the memory limit, so an instance that runs away
is killed rather than paging the whole NUC to a standstill. Both are visible from
outside:

```bash
docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' claudops-<id>
docker stats claudops-<id>
```

**Readiness.** `status` is the raw Docker state; `session` is whether a console
can attach, which is a different question. The entrypoint installs an egress
firewall and clones a repository before it starts anything, so a container is
`running` seconds to minutes before its tmux session exists. The base image
answers that itself, with a `HEALTHCHECK` running `tmux has-session`:

| `session` | Meaning |
| --- | --- |
| `starting` | The container runs, the session is not up yet. |
| `ready` | Attachable. The only state `GET /instances/:id/terminal` opens an exec in. |
| `failed` | The check kept failing past its five-minute start period -- the entrypoint never reached tmux. `docker logs` says why. |
| `none` | No running container to ask. |

The web UI disables its Console button for everything but `ready`, and the
terminal endpoint refuses `starting` and `failed` with `session_not_ready` before
it creates an exec. An instance whose image carries no healthcheck -- one built
before this existed -- reports `ready` while its container runs, which is the
behaviour that preceded the field.

**Activity.** A third field, next to `status` and `session`: what Claude is
doing in there, as the instance itself reports it.

| `activity` | Meaning |
| --- | --- |
| `idle` | The session is up and nobody has asked it for anything yet. |
| `running` | A turn is in flight. |
| `needs_input` | Claude asked something and is waiting for an answer. |
| `done` | The turn finished, or the session ended. |
| `none` | No running container, so nothing can be happening. |

The reports come from Claude Code's own hooks inside the container --
`UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd` -- which run
`/usr/local/bin/claudops-status` and post to the status listener. A container
that cannot report, or one from an image built before this existed, is read from
its tmux pane instead: that can tell a turn in flight from a quiet prompt, which
is all a pane can honestly say.

Two things are worth knowing about the values. A `Notification` also fires after
sixty idle seconds, and that one deliberately changes nothing -- otherwise every
finished instance would claim to need input a minute later. And `none` outranks
whatever was last reported, so a container that died cannot leave a `running`
standing: the process that would have sent the `Stop` went with it.

Nothing about this is stored. A server restart starts from "nothing reported"
and reads the panes again.

**Stop and start.** `POST /instances/:id/stop` stops the container and keeps
everything in it -- the workspace, the clone, the git state. `POST
/instances/:id/start` brings it back; the entrypoint runs again, so the tmux
session and Claude are new, while the filesystem is where it was. What is lost is
what was only in memory.

### Model and effort

Which model an instance runs, and at what effort level, is chosen when it is
created and can be changed while it runs. `model` is one of `opus`, `sonnet`,
`haiku`, `fable`; `effort` one of `low`, `medium`, `high`, `xhigh`, `max`.
`null` -- and leaving the field out on create -- means whatever Claude Code
picks itself. Anything else is a `400`.

```bash
curl -s localhost:8080/instances -H 'content-type: application/json' \
  -d '{"name":"demo","projectId":"<id>","model":"haiku","effort":"low"}'

curl -s -X PATCH localhost:8080/instances/<id> \
  -H 'content-type: application/json' -d '{"model":"opus"}'
```

A field that is not in the `PATCH` body keeps its stored value, the same rule
`PATCH /projects/:id` follows.

A switch has to reach two places, and the server does both before it writes the
row:

1. **The running session.** `/model` and `/effort` are typed into the instance's
   tmux pane, exactly as a person at the console would -- `/model` first,
   because which effort levels exist depends on the model. Nothing restarts and
   nothing is lost. Claude Code asks to confirm a switch while its prompt cache
   is still warm; that dialog is answered in the console, by a human, like any
   other. Until it is, the session keeps its old model.
2. **The next container start.** The chosen values are written to
   `~/.claudops/model` and `~/.claudops/effort` inside the container, which
   `docker/base/entrypoint.sh` prefers over `CLAUDE_MODEL` / `CLAUDE_EFFORT`.
   Docker cannot change a created container's environment, so without this a
   `docker stop` and `start` would silently bring the create-time value back.

Because step 1 needs a session, a `PATCH` against an instance whose `session` is
not `ready` is refused with `409 session_not_ready` rather than half-applied --
start the instance, wait for its session, then switch. A `PATCH` that changes
nothing is not refused; it never touches the container.

Resetting the model to Claude Code's own default (`"model": null`) reaches only
the next container start: there is no `/model` that means "back to the default",
and a bare `/model` opens a picker with nobody at the console to answer it.
`"effort": null` does have one -- `/effort auto` -- and takes effect at once. The
web UI offers a reset on neither, so this asymmetry stays out of sight.

**Delete.** `DELETE /instances/:id` removes the container with its anonymous
volumes, then any volume still carrying `claudops.instance=<id>`, then the row.
Nothing of that instance is left on the host.

**The startup reconcile.** Docker and the database can only disagree because
something died between two steps. Once, at startup, the server puts them back
together:

| Leftover | What happens |
| --- | --- |
| A container with a `claudops.instance` label that no instance points at | Removed, with its volumes |
| A volume whose instance does not exist any more | Removed |
| An instance whose container Docker does not have | Keeps its row, forgets the container id, reports `missing` |

The row is deliberately kept: it is somebody's instance, and deleting rows behind
their back is not cleanup. What the pass did is one log line; a removal it could
not do is a warning next to it, and the next restart tries again. A daemon that is
down at startup skips the whole thing -- the server runs without it.

There is no periodic sweep. Docker is asked for the state on every request
anyway, so a reconcile in between would only race with whoever is using the UI.

## Web UI

The built SPA from [`web/`](../web/README.md) is served at `/`, so browser and
API share one port and one origin. Exact routes win against the static wildcard,
and the SPA keeps its own routes in the fragment (`#/i/<id>`), so nothing here
shadows `/instances` and an unknown path still answers with the JSON 404.

`CLAUDOPS_WEB_ROOT` names the directory; by default it is `web/dist` next to this
package, resolved from the server's own location rather than from the working
directory. A directory without an `index.html` -- a checkout where `pnpm build`
never ran -- is not fatal: the server logs a warning and serves the API only.

## Attachments

`POST /instances/:id/files` puts one file into the instance and writes its path
into the console, so it is in Claude's prompt without anybody typing it out.

```bash
curl -s -X POST --data-binary @screenshot.png \
  -H 'content-type: application/octet-stream' \
  'localhost:8080/instances/<id>/files?name=screenshot.png'
```

```json
{
  "name": "screenshot.png",
  "path": "/workspace/.claudops/uploads/screenshot.png",
  "size": 184320,
  "announced": true
}
```

One file per request, and the body is the bytes as they are -- no multipart: a
single file needs no envelope, and a raw body is what lets the route own its
`bodyLimit` and refuse an oversized one before it is read. The content type has
to be `application/octet-stream`; anything Fastify parses itself answers `415`.

**Where it lands.** `/workspace/.claudops/uploads/`, a *sibling* of the clone in
`/workspace/<repo>`. An attachment therefore never turns up in the repository's
`git status` and cannot be committed by accident -- a property of the path, not
of a `.gitignore` somebody has to maintain. The file belongs to the container
user `claude`, mode `0644`.

**The name.** Only the last path segment survives, everything outside
`[A-Za-z0-9._-]` becomes an underscore, leading dots go, and a name over 80
characters is shortened from the front with its extension kept. So
`?name=../../etc/passwd` writes `/workspace/.claudops/uploads/passwd` and nothing
else. A name that is nothing but dots answers `400 invalid_filename`. A name
that is already taken is overwritten -- which is why the browser gives a pasted
screenshot a timestamp of its own.

**`announced`.** `true` when the path was typed into the tmux session with
`tmux send-keys -l` -- typed, not submitted: an Enter as well would send whatever
was half-written in the prompt along with it. `false` for an instance whose
session is not up yet; the file is there either way.

**Limits.** `CLAUDOPS_UPLOAD_MAX_FILE` per request and
`CLAUDOPS_UPLOAD_MAX_TOTAL` for everything one instance holds. Both answer
`413 upload_too_large` with a message naming the limit; the per-request one is
enforced by Fastify before the handler runs, so an oversized body is never read
into memory. What an instance holds is read out of the container on every
upload rather than counted in the database -- a `rm` in the console has to be
visible immediately.

## Files

The other direction from an attachment: what the instance produced. A run
leaves a screenshot, a report, a coverage file or a heap dump in `/workspace`,
and these two endpoints are how they get looked at without a commit and without
a `docker cp`.

```bash
curl -s 'localhost:8080/instances/<id>/files?path=/workspace/claudops'
```

```json
{
  "path": "/workspace/claudops",
  "parent": "/workspace",
  "truncated": false,
  "entries": [
    { "name": "src", "path": "/workspace/claudops/src", "kind": "directory",
      "size": 4096, "modifiedAt": "2026-08-29T09:12:03.000Z" },
    { "name": "REPORT.md", "path": "/workspace/claudops/REPORT.md", "kind": "file",
      "size": 182, "modifiedAt": "2026-08-29T09:41:55.000Z" }
  ]
}
```

**One directory per request.** Not a tree: the workspace holds a clone with its
`node_modules` and its `.git`, and a recursive walk of that is megabytes of
output for one click. Directories come first, then entries by name. `kind` is
`file`, `directory`, or `other` -- a symlink, a socket, a device, which is
neither browsable nor readable. A directory with more than 500 entries answers
the first 500 and sets `truncated`.

**The path.** Relative paths are relative to `/workspace`; absolute ones have to
be under it. Everything else answers `400 path_outside_workspace`, and so does a
path that *resolves* out of the workspace inside the container -- a symlink to
`/etc`. The two checks are separate on purpose: the first is about the string
the caller sent, the second about what it points at, and only the container can
answer the second
(knowledge/a-server-side-path-check-cannot-see-a-symlink.md).

**Reading one file.**

```bash
curl -s -OJ 'localhost:8080/instances/<id>/files/content?path=/workspace/shot.png&download=1'
```

The body is the bytes, not JSON: a screenshot in a JSON field is a third bigger
and has to be decoded before it can be shown, while a raw body is what an
`<img src>` and a download link both already understand.

**What it is served as.** One of three content types, chosen from the bytes
rather than from the name:

| Bytes | `content-type` | `content-disposition` |
| --- | --- | --- |
| A PNG, JPEG, GIF, WebP, AVIF, BMP or ICO by extension | `image/…` | `inline` |
| Anything that is valid UTF-8 without a NUL | `text/plain; charset=utf-8` | `inline` |
| Everything else | `application/octet-stream` | `attachment` |

`text/html` and `image/svg+xml` are never sent, whatever the file is called: this
is content an agent wrote, served from claudops' own origin to a browser
carrying the session cookie, and both of them execute. Markdown therefore
arrives as text and is rendered in the browser. Every response also carries
`X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none';
sandbox` and `Cache-Control: no-store`. `?download=1` keeps the type and turns
the disposition into `attachment`.

**Refusals.**

| Status | `error` | When |
| --- | --- | --- |
| `400` | `path_outside_workspace` | The path is not under `/workspace`, or resolves out of it |
| `400` | `wrong_path_kind` | A directory asked for its bytes, a file asked for its listing, a symlink either way |
| `404` | `path_not_found` | The instance is there, the path in it is not |
| `409` | `container_not_running` | Nothing to read from |
| `413` | `file_too_large` | Over `CLAUDOPS_FILE_MAX_READ` |

**The limit.** `CLAUDOPS_FILE_MAX_READ`, ten megabytes by default. Its own
number rather than the upload limit: the two travel in opposite directions and
are bounded for different reasons -- an upload to keep the NUC's disk, a read to
keep the server's memory, because a read is buffered before it is sent. The size
is read out of the container first, and the archive's own header is checked
again while it streams, so an oversized file is refused without its bytes
entering the server
(knowledge/reading-a-file-needs-getarchive-not-cat.md).

## Terminal

`GET /instances/:id/terminal` upgrades to a WebSocket and attaches a
`docker exec` with a TTY to the instance's tmux session. Every connection is its
own exec against the same session, so closing a tab and coming back finds the
scrollback and the running Claude untouched -- none of that lives in the server.

Two channels share the socket, split by frame type:

| Direction | Binary frame | Text frame |
| --- | --- | --- |
| Client to server | keystrokes, byte for byte | JSON control message; anything that is not a JSON object is typed instead, which is what makes `wscat` usable |
| Server to client | terminal output | JSON notice: `{"type":"error","code":…,"message":…}` |

The one control message today is a resize:

```json
{ "type": "resize", "cols": 120, "rows": 40 }
```

`?cols=&rows=` on the connect URL sets the geometry for the very first redraw, so
the console does not paint at 80x24 and reflow. Both are ignored when they are
not integers between 1 and 1000 -- a bad query string costs no console.

Close codes, mirroring the HTTP status the same condition would get:

| Code | Meaning |
| --- | --- |
| `1000` | The session ended: somebody detached with `Ctrl-b d`, the shell exited, the container stopped. |
| `4404` | No such instance. |
| `4409` | The instance exists but has no attachable container. The error frame names which case: `not_running`, `no_container`, or `session_not_ready` for a container whose tmux session is not up. |
| `4500` | Server-side failure. |
| `4503` | The Docker daemon did not answer. |

A dropped client is noticed by a ping every 30 seconds; a peer that stops
answering is terminated, which is what ends its exec.

Trying it by hand needs a WebSocket client:

```bash
npx wscat -c 'ws://localhost:8080/instances/<id>/terminal?cols=120&rows=40'
```

`wscat` sends text, so typing `ls` there types `ls` in the container. The
repository's own client is `server/scripts/ws-probe.ts`, which the smoke test
drives.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDOPS_HOST` | `0.0.0.0` | Listen address. |
| `CLAUDOPS_PORT` | `8080` | Listen port: the API, the WebSocket and the UI. |
| `CLAUDOPS_STATUS_HOST` | `0.0.0.0` | Listen address of the status listener. It has to be reachable from the docker bridge, so loopback is not an option; the per-instance token is what guards it. |
| `CLAUDOPS_STATUS_PORT` | `8081` | Listen port of the status listener -- one route, `POST /instances/:id/status`, and the only thing an instance may reach on the host. Must match `CLAUDOPS_STATUS_PORT` in the image, which is what the container's firewall opens and what its hooks dial. |
| `CLAUDOPS_DB` | `data/claudops.db` | SQLite file. Created together with its directory. |
| `CLAUDOPS_BASE_IMAGE` | `claudops-base` | What a project image is built `FROM`. Instances start from their project's image. |
| `CLAUDOPS_PROJECT_CONTEXT` | `docker/project` next to the package | Build context for project images. The tests point this at `docker/project-stub`. |
| `CLAUDOPS_DOTNET_CHANNEL` | `10.0` | Channel `dotnet-install.sh` gets for the dotnet block: a version, `LTS` or `STA`. |
| `CLAUDOPS_WEB_ROOT` | `web/dist` next to the package | Directory the web UI is served from. Without an `index.html` in it the server runs API-only. |
| `CLAUDOPS_TMUX_SESSION` | `main` | Session the terminal attaches to. Matches `TMUX_SESSION` in the image; only a project image with its own entrypoint needs another. |
| `CLAUDOPS_INSTANCE_CPUS` | `2` | CPU ceiling per instance, as `docker run --cpus` takes it. |
| `CLAUDOPS_INSTANCE_MEMORY` | `4g` | Memory ceiling per instance: a byte count or a `b`/`k`/`m`/`g` suffix, at least `6m`. Swap is capped at the same value. |
| `CLAUDOPS_UPLOAD_MAX_FILE` | `25m` | Largest single attachment, same notation. At least `1k`. |
| `CLAUDOPS_UPLOAD_MAX_TOTAL` | `200m` | Everything one instance's uploads directory may hold. Must not be smaller than the per-file limit. |
| `CLAUDOPS_FILE_MAX_READ` | `10m` | Largest file `GET /instances/:id/files/content` hands back, same notation. At least `1k`. |
| `CLAUDOPS_SECRET_KEY` | – | 32 bytes, base64 or hex: encrypts the PAT a project stores. Without it a project can be created but not with a `gitToken`. |
| `CLAUDOPS_LOGIN_SECRET` | – | **Required**, at least 16 characters. The shared secret `POST /login` takes. Without it the server exits 2 -- unlike the key above, because "unusable without a login" cannot hold if the login can be forgotten. |
| `CLAUDOPS_SESSION_SECURE` | – | `1` marks the session cookie `Secure`. Only behind TLS: over plain HTTP the browser discards it and the login appears to do nothing. |
| `CLAUDOPS_FIREWALL_ALLOW` | – | Extra hosts and CIDRs for an instance's egress whitelist, comma- or space-separated. Handed over as `FIREWALL_ALLOW`; rejected at startup if it is not a host list. |
| `CLAUDOPS_LOG_LEVEL` | `info` | Fastify log level. |
| `DOCKER_SOCKET` | platform default | `/var/run/docker.sock` on Linux, `//./pipe/docker_engine` on Windows. |
| `DOCKER_HOST` | – | If set and `DOCKER_SOCKET` is not, the transport is left to dockerode. |
| `CLAUDE_CODE_OAUTH_TOKEN` | – | Injected into every instance. Deliberately not an `ANTHROPIC_API_KEY`. |
| `CLAUDOPS_GIT_USER_NAME`, `CLAUDOPS_GIT_USER_EMAIL` | – | Commit identity handed to instances. |

## Structure

```
src/config.ts             environment -> typed config, read once at startup
src/db/                   SQLite: migrations, connection, the two repositories
src/docker/engine.ts      the port: everything the server needs from Docker
src/docker/dockerode-engine.ts   the real implementation
src/secrets/cipher.ts     AES-256-GCM for the one secret that is stored
src/auth/session.ts       the session token: one HMAC over an expiry
src/auth/cookie.ts        reading and writing that one cookie by hand
src/auth/gate.ts          the onRequest hook, and what is public without a login
src/auth/routes.ts        login, logout, session
src/projects/service.ts   projects: CRUD, the PAT, the in-use check
src/projects/images.ts    the image builds: queue, status, log, startup sweep
src/projects/routes.ts    REST endpoints and their schemas
src/docker/tar.ts         the one archive putArchive takes: a single file
src/instances/service.ts  orchestration: rows, containers, status join, attach, uploads
src/instances/routes.ts   REST endpoints and their schemas
src/instances/activity.ts what Claude is doing: hook events and pane text -> one word
src/status/tokens.ts      the per-instance token a container reports with
src/status/routes.ts      the one route on the status port
src/status/app.ts         the second Fastify app, on its own port
src/terminal/protocol.ts  the wire format: frames, close codes
src/terminal/bridge.ts    one socket to one TTY, both directions
src/terminal/routes.ts    the WebSocket endpoint
src/app.ts                Fastify instance, error mapping, /health, static UI
scripts/ws-probe.ts       WebSocket client for the smoke test
```

`docker/engine.ts` exists so the tests can run without a daemon:
`test/fake-engine.ts` implements the same interface, terminal sessions included.

## Test

```bash
pnpm test                          # vitest, no Docker needed
./server/smoke-test.sh             # the issue #3, #6, #7, #8, #15 and #18 acceptance criteria against real Docker
./server/terminal-smoke-test.sh    # the issue #4 acceptance criteria, real container and socket
./e2e/run.sh                       # the issue #5, #6, #7, #8, #15 and #18 acceptance criteria, in a real browser
./docker/project/smoke-test.sh     # the toolchains, really inside a project image
```

The three server-side scripts build project images from `docker/project-stub`, so
a run is not spent installing a dotnet SDK the assertions never look at.
`FULL_IMAGE=1 ./server/smoke-test.sh` uses the real template instead and checks
`dotnet --version` inside a running instance -- that one takes minutes.

`smoke-test.sh` needs network access: one of its instances really clones the
public claudops repository, which is how "the project's branch is what gets
checked out" is verified.

Both share `smoke-lib.sh` and clean up after themselves by label, so a failed run
leaves no containers behind.

`SKIP_BUILD=1` reuses the image and the build that are already there -- which
means it runs the *previous* `dist/`, so after a source change run the smoke test
without it or the result describes the code you replaced.

## Authentication

Everything is behind a session cookie except `/health`, the login endpoints and
the SPA shell -- which has to be public, because it *is* the login page and
carries no data of its own.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/login` | `{ "secret": "..." }` -> `200` and a `claudops_session` cookie. `401 invalid_secret` for a wrong one, `429 too_many_attempts` after ten wrong guesses a minute from one address. |
| `POST` | `/logout` | `204` and a cleared cookie. Public, so a stale cookie can always be cleared. |
| `GET` | `/session` | `200` with the expiry, or `401` -- which is the answer the SPA asks for before it paints anything. |

The cookie is an HMAC over an expiry, twelve hours, renewed past half-life. There
is no session store, so nothing survives a lost cookie and nothing revokes a
copied one (`knowledge/the-session-cookie-is-stateless.md`). One `onRequest` hook
does the checking, which is also what gates the WebSocket upgrade -- refused with
a plain HTTP 401 before the handler runs.

`server/scripts/ws-probe.ts` therefore takes a `--cookie`, and `smoke-lib.sh`
logs in as soon as `/health` answers.

## Not part of this yet

- Nothing from issue #1's package list. See the wiki for what is next.
