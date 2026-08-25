# claudops

Run isolated Claude Code instances in Docker containers on an Intel NUC, and
drive their consoles from the browser. Each instance clones a repository, starts
Claude Code inside a tmux session, and survives a browser refresh -- the session
lives in the container, not in the browser tab.

## State

Only the base image exists today. Everything else is planned; see the
[issues](https://github.com/dominikz98/claudops/issues) and
[EPIC #1](https://github.com/dominikz98/claudops/issues/1).

| Component | State |
| --- | --- |
| Base image `claudops-base` | Available, smoke-tested |
| Server (Fastify, dockerode, SQLite) | Planned (#3) |
| Terminal bridge (WebSocket) | Planned (#4) |
| Web UI (xterm.js) | Planned (#5) |
| Projects and project images | Planned (#6, #7) |
| Lifecycle, limits, recycling | Planned (#8) |
| Auth, egress firewall, UI login | Planned (#9) |

## Quick start

```bash
docker build -t claudops-base docker/base
```

```bash
docker run -d --name my-instance \
  -e REPO_URL=https://github.com/dominikz98/claudops.git \
  -e GIT_TOKEN="$GITHUB_PAT" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  claudops-base
```

```bash
docker exec -it my-instance tmux attach -t main
```

Detach with `Ctrl-b d`; Claude keeps running. The full walkthrough is in
[wiki/getting-started.md](wiki/getting-started.md).

## Layout

| Path | Contains |
| --- | --- |
| [`docker/base/`](docker/base/) | The `claudops-base` image, its entrypoint and its smoke test |
| [`wiki/`](wiki/README.md) | Documentation for users and colleagues: architecture, getting started, operations, glossary |
| [`knowledge/`](knowledge/README.md) | Domain knowledge database: the non-obvious decisions and their reasons |
| [`CLAUDE.md`](CLAUDE.md) | Project rules for Claude Code working in this repository |
| [`.claude/skills/`](.claude/skills/) | Skills that make those rules executable |

## Contributing

Read [CLAUDE.md](CLAUDE.md) first -- it defines how tickets are written, what
"done" means, and what a ticket close-out has to cover. In short: keep tickets
short, run every gate before opening a PR, and keep `knowledge/` and `wiki/` in
step with the change.

Branches are `feature/dz/<ticket>` or `bugfix/dz/<ticket>`. Everything in this
repository is written in English.

## Test

```bash
./docker/base/smoke-test.sh
```
