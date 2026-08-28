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

## Generate the secret key

A project stores the PAT for its repository, and it is encrypted before it
reaches the database. The key for that is 32 bytes, base64 or hex:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'
```

Keep it with the rest of your server configuration; it has to be the same on
every start, or the stored PATs can no longer be read. Losing it costs exactly
one thing: every project needs its token entered again. Without a key the server
still runs -- projects work, they just cannot hold a PAT, so private
repositories do not.

## Build the base image

```bash
docker build -t claudops-base docker/base
```

This is the only image built by hand. The environment of each project -- the
dotnet SDK, Playwright -- is built on top of it by the server, once per project.

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
CLAUDOPS_SECRET_KEY="$CLAUDOPS_SECRET_KEY" \
CLAUDOPS_GIT_USER_NAME="Your Name" \
CLAUDOPS_GIT_USER_EMAIL="you@example.com" \
node server/dist/index.js
```

It listens on port 8080. Open <http://localhost:8080> and the instance list is
there, with **Projects** in the top right;
`curl localhost:8080/health` answers `200` when Docker is reachable and
`503` when it is not -- that is the first thing to check if anything below
misbehaves. The full variable table is in
[server/README.md](../server/README.md).

## Create a project

An instance is created from a project: repository, branch, environment building
blocks and -- for a private repository -- the PAT. Open **Projects** in the top
right, fill in name and repository, optionally a branch and a token, tick the
building blocks the repository needs, and press Create. The token is masked,
stored encrypted and never shown again; the row says `stored` instead.

The **Image** column then goes from `queued` to `building` to `ready`. That is the
project's environment being built: `claudops-project-<id>`, the base image plus a
layer per building block. Nothing empty is quick and nothing with a dotnet SDK and
a Chromium is -- expect a few minutes the first time, and seconds for every
project after it that ticks the same boxes. **Build log** shows what the daemon is
doing, **Rebuild** starts over.

The same thing over the API:

```bash
curl -s localhost:8080/projects \
  -H 'content-type: application/json' \
  -d '{
        "name": "claudops",
        "repoUrl": "https://github.com/dominikz98/claudops.git",
        "repoBranch": "main",
        "gitToken": "'"$GITHUB_PAT"'",
        "buildingBlocks": { "dotnet": false, "playwright": false }
      }'
```

The answer carries the project `id`, and an `image` that is not built yet:

```json
{ "image": { "tag": "claudops-project-a1b2c3", "status": "pending", "builtAt": null } }
```

Builds are asynchronous, so poll until it is `ready` before creating an instance:

```bash
curl -s localhost:8080/projects/<project id>          # image.status
curl -s localhost:8080/projects/<project id>/build-log
```

A `failed` status means the build did not work; the log says why, and
`POST /projects/<id>/build` tries again. There is no fallback -- an instance
cannot start on an environment that was never built.

## Start an instance

In the browser: back on the instance list, fill in a name, pick the project,
optionally pick a model and an effort level, and press Create. The row appears
with the status Docker reports. A project whose image is not `ready` is greyed
out in the picker -- it would be a `422`.

The same thing over the API, with the project id from above:

```bash
curl -s localhost:8080/instances \
  -H 'content-type: application/json' \
  -d '{"name":"my-instance","projectId":"<project id>","model":"sonnet","effort":"high"}'
```

`model` and `effort` are optional. Left out, the instance runs whatever Claude
Code defaults to; given, they become `--model` and `--effort` on the `claude`
start line inside the container. Both can be changed later without restarting
anything -- see [Change the model of a running instance](operations.md#change-the-model-of-a-running-instance).

| Field | Values |
| --- | --- |
| `model` | `opus`, `sonnet`, `haiku`, `fable`, or left out |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max`, or left out |

The answer carries the instance `id` and the `containerId`. The container is
started from the project's image, clones the project's repository into
`/workspace/<repo-name>` and starts Claude Code there, inside a tmux session
called `main`. The instance keeps the repository, the branch and the image it was
started with, so editing or rebuilding the project later does not change what a
running instance is on.

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

## Pause an instance

**Stop** on the row stops the container and keeps everything in it. The row stays,
the status turns `exited`, and **Start** brings it back with its workspace, its
clone and its git state -- only what was in memory is gone, so Claude starts
fresh in a new tmux session. Over the API:

```bash
curl -s -X POST localhost:8080/instances/<id>/stop
curl -s -X POST localhost:8080/instances/<id>/start
```

This is what to do with an instance you are not using: a stopped container costs
no CPU and no memory, while a running one is allowed two cores and four
gigabytes of the NUC (see [operations](operations.md#resource-limits)).

## Remove an instance

**Delete** on the row, then the same button again to confirm. Or over the API:

```bash
curl -s -X DELETE localhost:8080/instances/<id>
```

The container goes with it, including its volumes -- so anything not pushed is
gone.

A project is deleted the same way, on the Projects page -- but only once no
instance points at it any more. While one does, the request answers `409` and the
banner says how many are in the way:

```bash
curl -s -X DELETE localhost:8080/projects/<id>
```

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
| `CLAUDOPS_SECRET_KEY` | 32 bytes, base64 or hex: encrypts the PAT a project stores. |
| `CLAUDOPS_LOGIN_SECRET` | **Required.** The shared secret the UI asks for, at least 16 characters. Without it the server refuses to start. |
| `CLAUDOPS_SESSION_SECURE` | `1` marks the session cookie `Secure`. Only with TLS in front -- over plain HTTP a browser discards it and the login silently fails. |
| `CLAUDOPS_FIREWALL_ALLOW` | Extra hosts and CIDRs an instance's egress firewall lets through, comma- or space-separated, on top of its built-in list. |
| `CLAUDOPS_GIT_USER_NAME`, `CLAUDOPS_GIT_USER_EMAIL` | Commit identity for instances. |

| On a project | Purpose |
| --- | --- |
| `name` | Label, unique across projects. Required. |
| `repoUrl` | Repository every instance of this project clones. Required. |
| `repoBranch` | Branch, default `main` in the container. |
| `gitToken` | PAT for a private repo. Stored encrypted, never logged or returned. |
| `buildingBlocks` | `dotnet` and `playwright` flags. Stored today, built with #7. |

| On an instance | Purpose |
| --- | --- |
| `name` | Label for the instance. Required. |
| `projectId` | The project it is created from. Required -- there is nothing else to configure. |

Full tables: [server/README.md](../server/README.md) for the server,
[docker/base/README.md](../docker/base/README.md) for what the container
understands.

## Verify it works

```bash
./docker/base/smoke-test.sh          # the image: clone, non-root, reattach, credentials
./server/smoke-test.sh               # the server: create, list with status, delete, project images
./server/terminal-smoke-test.sh      # the console: I/O, reconnect, resize
./e2e/run.sh                         # the UI: create, drive, refresh, delete -- in a browser
./docker/project/smoke-test.sh       # a project image: dotnet and a browser, really inside it
pnpm test                            # unit tests, no Docker needed
```

The three server-side scripts build project images from `docker/project-stub`, so
they are not spent installing a toolchain their assertions never look at.
`./docker/project/smoke-test.sh` is the one that builds the real thing, and
`FULL_IMAGE=1 ./server/smoke-test.sh` checks `dotnet --version` inside a running
instance. Both take minutes.

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
