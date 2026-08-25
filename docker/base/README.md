# `claudops-base`

Shared base image for all Claude Code instances. On start the container clones a
repository and runs Claude Code inside a tmux session, which the claudops server
attaches to later via `docker exec ... tmux attach`.

Project images (issue #7) build on top of it via `FROM claudops-base`.

## Build

```bash
docker build -t claudops-base docker/base
```

Optionally pin the Claude Code version:

```bash
docker build -t claudops-base --build-arg CLAUDE_CODE_VERSION=1.2.3 docker/base
```

## Run

```bash
docker run -d --name claudops-demo \
  -e REPO_URL=https://github.com/dominikz98/claudops.git \
  -e REPO_BRANCH=main \
  -e GIT_TOKEN="$GITHUB_PAT" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  claudops-base
```

Open the console on the host -- the same session the server's terminal bridge
attaches to:

```bash
docker exec -it claudops-demo tmux attach -t main
```

Detach with `Ctrl-b d` -- Claude keeps running, and attaching again finds the
session and its scrollback intact. The same holds when the connection simply
drops.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPO_URL` | – | Repository cloned into `/workspace/<name>`. Without it the session starts in `/workspace`. |
| `REPO_BRANCH` | `main` | Branch to clone. |
| `GIT_TOKEN` | – | PAT for private repos. Served through a credential helper from the environment, so it never lands in `.git/config` or `git remote -v`. |
| `GIT_TOKEN_HOST` | host from `REPO_URL` | Restricts which host the helper shows the token to. |
| `GIT_USERNAME` | `x-access-token` | Username for the token (GitHub accepts any value). |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | – | Commit identity for Claude. |
| `CLAUDE_CODE_OAUTH_TOKEN` | – | Auth for Claude Code (`claude setup-token`). Deliberately **not** an `ANTHROPIC_API_KEY` -- that one overrides the subscription. |
| `CLAUDE_ARGS` | `--dangerously-skip-permissions` | Arguments for the `claude` start. Only acceptable because of the container isolation. |
| `WORKSPACE_DIR` | `/workspace` | Base directory for clones. |
| `TMUX_SESSION` | `main` | Session name the bridge attaches to. |

## Behaviour

- **Non-root:** everything runs as `claude` (UID 1001; 1000 is taken in the
  `node` image).
- **A failed clone does not abort.** The tmux session still starts in
  `/workspace` so you can attach through the console and inspect the cause
  (wrong PAT, wrong branch). A dead container would be unreachable for that.
- **Restarting the container on the same volume** skips the clone if the target
  directory already is a git repo.
- **`docker stop`** shuts the tmux server down cleanly via SIGTERM.
- **PID 1** is the entrypoint; it watches over the session and exits when the
  session ends.

## Test

```bash
./docker/base/smoke-test.sh
```

Builds the image, brings up a container and checks the acceptance criteria from
issue #2 (clone, non-root, detach/reattach with scrollback, running Claude
process) plus the behaviour of the credential helper. `SKIP_BUILD=1` skips the
build.

## Not part of this image

- Egress firewall (`init-firewall.sh`, `NET_ADMIN`) and UI login -> issue #9
- CPU/RAM limits and recycling -> issue #8
- dotnet/Playwright building blocks -> issue #7
