# Getting started

What works today is the base image: build it, start an instance by hand, use the
Claude console through tmux. The server and the web UI that automate this are
planned (#3, #5).

## Prerequisites

- Docker (Linux host, or Docker Desktop for a local try-out)
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

## Start an instance

```bash
docker run -d --name my-instance \
  -e REPO_URL=https://github.com/dominikz98/claudops.git \
  -e REPO_BRANCH=main \
  -e GIT_TOKEN="$GITHUB_PAT" \
  -e GIT_USER_NAME="Your Name" \
  -e GIT_USER_EMAIL="you@example.com" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  claudops-base
```

The container clones the repository into `/workspace/<repo-name>` and starts
Claude Code there, inside a tmux session called `main`.

## Use the console

```bash
docker exec -it my-instance tmux attach -t main
```

Detach with `Ctrl-b d`. Claude keeps running, and attaching again finds the
session and the scrollback where you left them -- the same is true if your
connection simply drops. This is the behaviour the browser console will be built
on (#4, #5).

## Environment variables

The full table is in [docker/base/README.md](../docker/base/README.md). The ones
you will actually set:

| Variable | Purpose |
| --- | --- |
| `REPO_URL` | Repository to clone. Without it the session starts in `/workspace`. |
| `REPO_BRANCH` | Branch, default `main`. |
| `GIT_TOKEN` | PAT for private repos. Never appears in `.git/config` or `git remote -v`. |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | Commit identity Claude will use. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code auth. |

## Verify the image

```bash
./docker/base/smoke-test.sh
```

Builds the image, brings a container up and checks clone, non-root, detach and
reattach with scrollback, and the credential helper. `SKIP_BUILD=1` reuses an
image you already built.

## Clean up

```bash
docker rm -f my-instance
```

## When something is wrong

See [Operations](operations.md).
