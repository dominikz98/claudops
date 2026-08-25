# Getting started

From nothing to a running Claude Code instance. The server does the starting
and stopping; the console still goes through tmux until the browser console
lands (#5).

## Prerequisites

- Docker (Linux host, or Docker Desktop for a local try-out)
- Node 22 or newer and pnpm
- A Claude Code OAuth token
- For private repositories: a GitHub PAT with read access

## Get the Claude token

On any machine with Claude Code installed:

```bash
claude setup-token
```

Keep the value. It goes into the container as `CLAUDE_CODE_OAUTH_TOKEN`. Do not
set `ANTHROPIC_API_KEY` next to it -- it would override the subscription and
usage would be billed per token.

## Build the image

```bash
docker build -t claudops-base docker/base
```

## Start the server

```bash
pnpm install
pnpm build
```

The server needs the Claude token and the commit identity for the instances it
will start:

```bash
CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
CLAUDOPS_GIT_USER_NAME="Your Name" \
CLAUDOPS_GIT_USER_EMAIL="you@example.com" \
node server/dist/index.js
```

It listens on port 8080. `curl localhost:8080/health` answers `200` when Docker
is reachable and `503` when it is not -- that is the first thing to check if
anything below misbehaves. The full variable table is in
[server/README.md](../server/README.md).

## Start an instance

```bash
curl -s localhost:8080/instances \
  -H 'content-type: application/json' \
  -d '{
        "name": "my-instance",
        "repoUrl": "https://github.com/dominikz98/claudops.git",
        "repoBranch": "main",
        "gitToken": "'"$GITHUB_PAT"'"
      }'
```

The answer carries the instance `id` and the `containerId`. The container clones
the repository into `/workspace/<repo-name>` and starts Claude Code there, inside
a tmux session called `main`.

```bash
curl -s localhost:8080/instances     # every instance with its Docker status
```

The status comes from Docker itself on every request, so a container that died
shows up as `exited` rather than as whatever it was when it started.

## Use the console

```bash
docker exec -it claudops-<id> tmux attach -t main
```

Detach with `Ctrl-b d`. Claude keeps running, and attaching again finds the
session and the scrollback where you left them -- the same is true if your
connection simply drops. This is the behaviour the browser console will be built
on (#4, #5).

## Remove an instance

```bash
curl -s -X DELETE localhost:8080/instances/<id>
```

The container goes with it, including its anonymous volumes -- so anything not
pushed is gone.

## Without the server

An instance can still be started by hand, which is useful when you want to try
an image change without a server in the way:

```bash
docker run -d --name my-instance \
  -e REPO_URL=https://github.com/dominikz98/claudops.git \
  -e REPO_BRANCH=main \
  -e GIT_TOKEN="$GITHUB_PAT" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  claudops-base
```

The server will not know about it: it lists what is in its database, and a
hand-started container has no row. It also carries no `claudops.instance` label,
so the cleanup commands in [operations](operations.md) will not find it either.

## What goes where

The server is configured through its own variables and passes a different set
into each container.

| For the server | Purpose |
| --- | --- |
| `CLAUDOPS_PORT` | Listen port, default `8080`. |
| `CLAUDOPS_DB` | SQLite file, default `data/claudops.db`. |
| `CLAUDOPS_BASE_IMAGE` | Image instances start from, default `claudops-base`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code auth, injected into every instance. |
| `CLAUDOPS_GIT_USER_NAME`, `CLAUDOPS_GIT_USER_EMAIL` | Commit identity for instances. |

| Per request | Purpose |
| --- | --- |
| `name` | Label for the instance. Required. |
| `repoUrl` | Repository to clone. Without it the session starts in `/workspace`. |
| `repoBranch` | Branch, default `main`. |
| `gitToken` | PAT for a private repo. Never stored, logged or returned. |

Full tables: [server/README.md](../server/README.md) for the server,
[docker/base/README.md](../docker/base/README.md) for what the container
understands.

## Verify it works

```bash
./docker/base/smoke-test.sh    # the image: clone, non-root, reattach, credentials
./server/smoke-test.sh         # the server: create, list with status, delete
pnpm test                      # unit tests, no Docker needed
```

`SKIP_BUILD=1` makes either smoke test reuse what is already built.

## Clean up

```bash
curl -s -X DELETE localhost:8080/instances/<id>
```

For anything the server does not know about, see [operations](operations.md).

## When something is wrong

See [Operations](operations.md).
