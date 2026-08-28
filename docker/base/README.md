# `claudops-base`

Shared base image for all Claude Code instances. On start the container clones a
repository and runs Claude Code inside a tmux session, which the claudops server
attaches to later via `docker exec ... tmux attach`.

Project images build on top of it via `FROM claudops-base` -- see
[`../project/README.md`](../project/README.md). This is the only image built by
hand; the per-project ones are built by the server.

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
  --cap-add=NET_ADMIN \
  -e REPO_URL=https://github.com/dominikz98/claudops.git \
  -e REPO_BRANCH=main \
  -e GIT_TOKEN="$GITHUB_PAT" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  claudops-base
```

`--cap-add=NET_ADMIN` is not optional: the entrypoint installs an egress firewall
on itself before it clones anything, and without the capability that fails, the
container ends up with no Claude in it, and `/run/claudops-firewall.state` says
`unfiltered`.

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
| `CLAUDE_ARGS` | `--dangerously-skip-permissions` | Arguments for the `claude` start. Only acceptable because of the container isolation, which is what the egress firewall below provides. |
| `CLAUDE_MODEL` | – | Model alias -- `opus`, `sonnet`, `haiku`, `fable` -- appended as `--model`. Deliberately **not** `ANTHROPIC_MODEL`: see below. |
| `CLAUDE_EFFORT` | – | Effort level -- `low`, `medium`, `high`, `xhigh`, `max` -- appended as `--effort`. Deliberately **not** `CLAUDE_CODE_EFFORT_LEVEL`: that one outranks `/effort` and would make a switch in the console do nothing. |
| `FIREWALL_ALLOW` | – | Extra hosts and CIDRs for the egress whitelist, comma- or space-separated, on top of the built-in list in `/etc/claudops/firewall-allow.d`. |
| `FIREWALL_MODE` | `enforce` | `off` skips the firewall entirely. The operator's escape hatch, never the agent's -- and it is also what makes `CLAUDE_ARGS` unsafe. |
| `FIREWALL_REFRESH_SECONDS` | `900` | How often the whitelist is re-resolved, because CDN addresses rotate. `0` disables it. |
| `WORKSPACE_DIR` | `/workspace` | Base directory for clones. |
| `TMUX_SESSION` | `main` | Session name the bridge attaches to, and the one the healthcheck looks for. |
| `TERM` | `xterm-256color` | Without it `tmux attach` from a `docker exec` fails with "terminal does not support clear". A client with its own `TERM` overrides it. |
| `LANG` | `C.UTF-8` | Tells tmux the attaching client can take UTF-8. Without it every multi-byte character leaves the tmux server as `_` and Claude's TUI arrives as rows of underscores. |

## Behaviour

- **Non-root:** everything runs as `claude` (UID 1001; 1000 is taken in the
  `node` image). `iptables` is the one exception, and it is reached through a
  single `NOPASSWD` sudoers entry scoped to `init-firewall.sh` with no arguments
  -- `claude` is not in the `sudo` group
  (`knowledge/iptables-needs-root-not-just-net-admin.md`).
- **Default-deny egress.** Before the clone, the entrypoint runs
  `init-firewall.sh`: it resolves the built-in host list, GitHub's published
  ranges and the host of `REPO_URL` into an ipset, then sets the `INPUT`,
  `OUTPUT` and `FORWARD` policies to DROP. The container's own subnet is
  deliberately **not** whitelisted, so an instance reaches neither the claudops
  API on the docker gateway nor its neighbours. Requires `NET_ADMIN`.
- **The firewall is configured once per container start.** A second run is
  refused, so the agent in the container cannot widen its own whitelist. The
  guard is the `CLAUDOPS-EGRESS` chain itself; `docker restart` is the only way to
  configure it again.
- **A failed firewall does not abort, but Claude is withheld.** The tmux session
  comes up with a plain shell and the pane says why, so the console still works
  for diagnosis -- but `claude` is not started, because an agent with
  `--dangerously-skip-permissions` and unrestricted egress is exactly what the
  firewall exists to prevent. `/run/claudops-firewall.state` distinguishes
  `failed` (sealed to loopback) from `unfiltered` (nothing could be applied).
- **The image build is not firewalled.** The firewall is installed at container
  start, so `docker build` -- including the dotnet and Playwright building blocks
  of a project image -- reaches whatever it needs.
- **A failed clone does not abort.** The tmux session still starts in
  `/workspace` so you can attach through the console and inspect the cause
  (wrong PAT, wrong branch). A dead container would be unreachable for that.
- **Claude Code's first-start questions are answered in advance.** A fresh
  container is always a first start, so without this the console opens on the
  theme picker, then the workspace trust prompt, then the confirmation of
  `--dangerously-skip-permissions` -- three dialogs, none of which an operator can
  answer from the instance list. The image seeds `~/.claude.json` (0600, no
  credential in it) and the entrypoint adds the trust entry for the directory it
  cloned into, because a git repository is its own trust root and its name is only
  known at start
  (`knowledge/claude-onboarding-must-be-pre-seeded.md`). Pre-accepting the
  bypass-permissions warning is the same decision as the `CLAUDE_ARGS` default
  above, not an additional one.
- **The container reports when its session is up.** A `HEALTHCHECK` runs
  `tmux has-session -t "$TMUX_SESSION"` every five seconds, so
  `docker inspect -f '{{.State.Health.Status}}'` tells "the container started"
  apart from "a console can attach". claudops reads exactly that and keeps its
  Console button disabled until then. The start period is five minutes, which is
  a large clone over a slow line; past it, a container that still has no session
  goes `unhealthy` rather than staying on `starting` forever.
- **The model and the effort level are start arguments, and can be overwritten
  from outside.** `CLAUDE_MODEL` and `CLAUDE_EFFORT` become `--model` and
  `--effort` on the `claude` start line. Two files take precedence over them:

  ```bash
  docker exec claudops-demo sh -c 'mkdir -p ~/.claudops && printf %s sonnet > ~/.claudops/model'
  ```

  That is what claudops writes when the model is switched from the UI, because
  Docker cannot change a created container's environment and the next
  `docker restart` would otherwise bring the old value back. An **empty** file
  means "no flag"; a file that does not exist falls back to the environment.
  Anything that is not a plain `[A-Za-z0-9._-]+` word is ignored with a warning,
  so the file can never grow a second argument. Switching a *running* session is
  a `/model` or `/effort` typed into it -- claudops does that itself, and from
  the console you would simply type it.
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
process) plus the behaviour of the credential helper and the egress firewall of
issue #9 -- including a second container started *without* `NET_ADMIN`, to prove
Claude is withheld when the firewall cannot come up. The last block is issue
#16: the chosen model and effort really are on the `claude` process, and a
`docker restart` reads the override files rather than the environment.
`SKIP_BUILD=1` skips the build.

The run needs outbound access to `api.github.com/meta`: that is where the
whitelist gets GitHub's IP ranges, and the clone assertions depend on it.

## Not part of this image

- The UI login -> `server/README.md`. It protects the server, not the container.
- CPU/RAM limits and recycling -> issue #8
- dotnet/Playwright building blocks -> [`../project`](../project/README.md)
