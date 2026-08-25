# Getting started

From nothing to a running Claude Code instance, driven from the browser.

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

`pnpm build` builds the server *and* the web UI -- the server serves the UI from
`web/dist`, so skipping it leaves you with the API alone (and a warning in the
log).

The server needs the Claude token and the commit identity for the instances it
will start:

```bash
CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
CLAUDOPS_GIT_USER_NAME="Your Name" \
CLAUDOPS_GIT_USER_EMAIL="you@example.com" \
node server/dist/index.js
```

It listens on port 8080. Open <http://localhost:8080> and the instance list is
there; `curl localhost:8080/health` answers `200` when Docker is reachable and
`503` when it is not -- that is the first thing to check if anything below
misbehaves. The full variable table is in
[server/README.md](../server/README.md).

## Start an instance

In the browser: fill in a name, optionally a repository, branch and a PAT for a
private one, and press Create. The row appears with the status Docker reports.

The same thing over the API:

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

Click **Console** on the instance. The page attaches to the tmux session in the
container and you are in Claude Code; the status line at the top right shows the
geometry the container is being told about. Reload the page and you land back in
the same session, with the scrollback and whatever was running still there.

Without a browser, over the server:

```bash
npx wscat -c 'ws://localhost:8080/instances/<id>/terminal?cols=120&rows=40'
```

Or directly on the host, which needs no server at all:

```bash
docker exec -it claudops-<id> tmux attach -t main
```

Detach with `Ctrl-b d`. Claude keeps running, and attaching again finds the
session and the scrollback where you left them -- the same is true if your
connection simply drops. `cols` and `rows` are optional and only decide how the
first redraw is painted; a real client sends a resize whenever its window
changes.

## Remove an instance

**Delete** on the row, then the same button again to confirm. Or over the API:

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
| `CLAUDOPS_TMUX_SESSION` | Session the console attaches to, default `main`. |
| `CLAUDOPS_WEB_ROOT` | Where the built UI is, default `web/dist` next to the server. |
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
./docker/base/smoke-test.sh          # the image: clone, non-root, reattach, credentials
./server/smoke-test.sh               # the server: create, list with status, delete
./server/terminal-smoke-test.sh      # the console: I/O, reconnect, resize
./e2e/run.sh                         # the UI: create, drive, refresh, delete -- in a browser
pnpm test                            # unit tests, no Docker needed
```

`./e2e/run.sh` drives a real browser and needs Chromium once per machine:

```bash
pnpm --filter @claudops/e2e exec playwright install chromium
```

`SKIP_BUILD=1` makes a smoke test reuse what is already built -- handy, but after
a code change it then tests the previous build. All of them remove every
container carrying the claudops label when they exit, so do not run one next to
an instance you care about.

## Clean up

Delete the instance in the browser, or:

```bash
curl -s -X DELETE localhost:8080/instances/<id>
```

For anything the server does not know about, see [operations](operations.md).

## When something is wrong

See [Operations](operations.md).
