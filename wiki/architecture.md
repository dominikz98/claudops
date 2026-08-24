# Architecture

claudops starts isolated Claude Code instances in Docker containers on an Intel
NUC and mirrors their consoles into the browser.

```
Browser (xterm.js) <=> WebSocket <=> claudops-server (Node/TS)
                                      |- REST: projects and instances (SQLite)
                                      |- dockerode -> Docker Engine
                                      +- image builds per project

Container per instance: project image -> clone repo -> tmux -> claude
```

## Components

| Component | Role | State |
| --- | --- | --- |
| `claudops-base` | Base image: Node, Claude Code CLI, git, tmux, non-root user, entrypoint | Available |
| `claudops-server` | Fastify: REST for projects and instances, image builds, terminal bridge | Planned (#3, #4) |
| Web UI | Vite SPA served by the server on the same port: instance list and console | Planned (#5) |
| SQLite | Metadata for projects and instances | Planned (#3) |

## Decisions worth knowing

**The console rides on tmux.** The container starts Claude inside a tmux session.
The bridge attaches to it with `docker exec` on a TTY and pipes the raw stream to
xterm.js. That is what makes a browser refresh survivable: the session, the
scrollback and the running Claude are in the container, not in the server or the
browser.

**Environments are prebuilt images.** A project defines its environment through
building blocks (dotnet, Playwright); the server builds a project image from them
once and instances start from it. devcontainer features were rejected -- they
install at container start and cache nothing.

**Every resource is labelled.** Containers and volumes carry
`claudops.instance=<id>`, which is what makes a complete delete and a startup
reconcile possible. Planned (#8).

**Isolation is what permits the risk.** Claude runs with
`--dangerously-skip-permissions`, which is only acceptable because the container
is isolated and its egress is restricted to a whitelist. Planned (#9).

**The Claude token is an OAuth token.** Instances get `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token`. An `ANTHROPIC_API_KEY` is deliberately never set -- it
would override the subscription and bill per token.

## Order of work

Packages #2 to #5 produce the first walking skeleton: start an instance, use its
console in the browser. #6 to #9 make it usable in practice. See issue #1.
