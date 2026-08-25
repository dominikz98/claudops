# `@claudops/server`

Fastify server that starts Claude Code instances as Docker containers and keeps
their metadata in SQLite. The terminal bridge (#4) and the web UI (#5) will be
served from the same process.

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
| `GET` | `/health` | Readiness: `200` when the Docker daemon answers, `503` when it does not. |
| `POST` | `/instances` | Start an instance. Body: `name` (required), `repoUrl`, `repoBranch`, `gitToken`. Answers `201` with the instance. |
| `GET` | `/instances` | All instances, each with the status Docker reports. |
| `GET` | `/instances/:id` | One instance. `404` if unknown. |
| `DELETE` | `/instances/:id` | Remove the container and the instance. `204`, or `404` if unknown. |

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

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDOPS_HOST` | `0.0.0.0` | Listen address. |
| `CLAUDOPS_PORT` | `8080` | Listen port. |
| `CLAUDOPS_DB` | `data/claudops.db` | SQLite file. Created together with its directory. |
| `CLAUDOPS_BASE_IMAGE` | `claudops-base` | Image instances are started from. Per-project images arrive with #7. |
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
src/instances/service.ts  orchestration: rows, containers, status join
src/instances/routes.ts   REST endpoints and their schemas
src/app.ts                Fastify instance, error mapping, /health
```

`docker/engine.ts` exists so the tests can run without a daemon:
`test/fake-engine.ts` implements the same interface.

## Test

```bash
pnpm test                     # vitest, no Docker needed
./server/smoke-test.sh        # the issue #3 acceptance criteria against real Docker
```

`SKIP_BUILD=1` reuses the image and the build that are already there. The smoke
test cleans up after itself by label, so a failed run leaves no containers
behind.

## Not part of this yet

- Terminal bridge (WebSocket to a container TTY) -> #4
- Web UI -> #5
- Projects and per-project images -> #6, #7
- Resource limits, startup reconcile -> #8
- Auth, egress firewall -> #9
