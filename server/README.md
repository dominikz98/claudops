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
| `POST` | `/instances` | Start an instance. Body: `name` (required), `repoUrl`, `repoBranch`, `gitToken`. Answers `201` with the instance. |
| `GET` | `/instances` | All instances, each with the status Docker reports. |
| `GET` | `/instances/:id` | One instance. `404` if unknown. |
| `DELETE` | `/instances/:id` | Remove the container and the instance. `204`, or `404` if unknown. |
| `GET` | `/instances/:id/terminal` | WebSocket: the instance console. See [Terminal](#terminal). |

```bash
curl -s localhost:8080/instances \
  -H 'content-type: application/json' \
  -d '{"name":"demo","repoUrl":"https://github.com/dominikz98/claudops.git","repoBranch":"main"}'
```

Status codes worth knowing: `400` for a body that fails validation -- including
an unknown field, which is rejected rather than dropped -- `422` when the base
image is not built, `503` while the Docker daemon is unreachable.

`gitToken` is passed into the container environment and is never stored, logged
or echoed back.

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
| `CLAUDOPS_BASE_IMAGE` | `claudops-base` | Image instances are started from. Per-project images arrive with #7. |
| `CLAUDOPS_WEB_ROOT` | `web/dist` next to the package | Directory the web UI is served from. Without an `index.html` in it the server runs API-only. |
| `CLAUDOPS_TMUX_SESSION` | `main` | Session the terminal attaches to. Matches `TMUX_SESSION` in the image; only a project image with its own entrypoint needs another. |
| `CLAUDOPS_LOG_LEVEL` | `info` | Fastify log level. |
| `DOCKER_SOCKET` | platform default | `/var/run/docker.sock` on Linux, `//./pipe/docker_engine` on Windows. |
| `DOCKER_HOST` | – | If set and `DOCKER_SOCKET` is not, the transport is left to dockerode. |
| `CLAUDE_CODE_OAUTH_TOKEN` | – | Injected into every instance. Deliberately not an `ANTHROPIC_API_KEY`. |
| `CLAUDOPS_GIT_USER_NAME`, `CLAUDOPS_GIT_USER_EMAIL` | – | Commit identity handed to instances. |

## Structure

```
src/config.ts             environment -> typed config, read once at startup
src/db/                   SQLite: migrations, connection, instance repository
src/docker/engine.ts      the port: everything the server needs from Docker
src/docker/dockerode-engine.ts   the real implementation
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
./server/smoke-test.sh             # the issue #3 acceptance criteria against real Docker
./server/terminal-smoke-test.sh    # the issue #4 acceptance criteria, real container and socket
./e2e/run.sh                       # the issue #5 acceptance criteria, in a real browser
```

Both share `smoke-lib.sh` and clean up after themselves by label, so a failed run
leaves no containers behind.

`SKIP_BUILD=1` reuses the image and the build that are already there -- which
means it runs the *previous* `dist/`, so after a source change run the smoke test
without it or the result describes the code you replaced.

## Not part of this yet

- Projects and per-project images -> #6, #7
- Resource limits, startup reconcile -> #8
- Auth, egress firewall -> #9
