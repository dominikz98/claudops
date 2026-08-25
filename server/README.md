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
| `POST` | `/instances` | Start an instance from a project. Body: `name`, `projectId` (both required). Answers `201` with the instance. |
| `GET` | `/instances` | All instances, each with the status Docker reports. |
| `GET` | `/instances/:id` | One instance. `404` if unknown. |
| `POST` | `/instances/:id/stop` | Stop the container, keep the instance. Answers `200` with its new status. |
| `POST` | `/instances/:id/start` | Start it again. `200`, `409` when the instance has no container. |
| `DELETE` | `/instances/:id` | Remove the container, its volumes and the instance. `204`, or `404` if unknown. |
| `GET` | `/instances/:id/terminal` | WebSocket: the instance console. See [Terminal](#terminal). |

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
project name, a project still in use, or an instance whose container is gone,
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

The stored log is capped at the last 64 KiB, with a line saying what was dropped.
The tail is where the failing step is, and the database is not a log server.

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

**Stop and start.** `POST /instances/:id/stop` stops the container and keeps
everything in it -- the workspace, the clone, the git state. `POST
/instances/:id/start` brings it back; the entrypoint runs again, so the tmux
session and Claude are new, while the filesystem is where it was. What is lost is
what was only in memory.

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
| `4409` | The instance exists but has no attachable container, or the terminal process exited non-zero -- which is what "no tmux session to attach to" looks like. |
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
| `CLAUDOPS_PORT` | `8080` | Listen port. |
| `CLAUDOPS_DB` | `data/claudops.db` | SQLite file. Created together with its directory. |
| `CLAUDOPS_BASE_IMAGE` | `claudops-base` | What a project image is built `FROM`. Instances start from their project's image. |
| `CLAUDOPS_PROJECT_CONTEXT` | `docker/project` next to the package | Build context for project images. The tests point this at `docker/project-stub`. |
| `CLAUDOPS_DOTNET_CHANNEL` | `10.0` | Channel `dotnet-install.sh` gets for the dotnet block: a version, `LTS` or `STA`. |
| `CLAUDOPS_WEB_ROOT` | `web/dist` next to the package | Directory the web UI is served from. Without an `index.html` in it the server runs API-only. |
| `CLAUDOPS_TMUX_SESSION` | `main` | Session the terminal attaches to. Matches `TMUX_SESSION` in the image; only a project image with its own entrypoint needs another. |
| `CLAUDOPS_INSTANCE_CPUS` | `2` | CPU ceiling per instance, as `docker run --cpus` takes it. |
| `CLAUDOPS_INSTANCE_MEMORY` | `4g` | Memory ceiling per instance: a byte count or a `b`/`k`/`m`/`g` suffix, at least `6m`. Swap is capped at the same value. |
| `CLAUDOPS_SECRET_KEY` | – | 32 bytes, base64 or hex: encrypts the PAT a project stores. Without it a project can be created but not with a `gitToken`. |
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
src/projects/service.ts   projects: CRUD, the PAT, the in-use check
src/projects/images.ts    the image builds: queue, status, log, startup sweep
src/projects/routes.ts    REST endpoints and their schemas
src/instances/service.ts  orchestration: rows, containers, status join, attach
src/instances/routes.ts   REST endpoints and their schemas
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
./server/smoke-test.sh             # the issue #3, #6, #7 and #8 acceptance criteria against real Docker
./server/terminal-smoke-test.sh    # the issue #4 acceptance criteria, real container and socket
./e2e/run.sh                       # the issue #5, #6, #7 and #8 acceptance criteria, in a real browser
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

## Not part of this yet

- Auth, egress firewall -> #9
