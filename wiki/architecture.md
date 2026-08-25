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
| `claudops-server` | Fastify: REST for instances today, projects and terminal bridge to come | Instance REST available; #4, #6 open |
| Web UI | Vite SPA served by the server on the same port: instance list and console | Planned (#5) |
| SQLite | Metadata for instances; projects join it with #6 | Available |

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
reconcile possible. The label is set on create; the reconcile that uses it at
startup is #8.

**Docker owns the state, SQLite owns the identity.** The instance table has no
status column. Every list request asks Docker for the state of the labelled
containers and joins it onto the rows, so a container somebody stopped by hand
shows as `exited` instead of as whatever the server last wrote down. An instance
whose container is gone reports `missing` rather than disappearing, because that
is the case #8 has to clean up. Creating goes row first, container second, and
rolls the row back on failure -- a container without a row would have no handle
left to find it by.

**Isolation is what permits the risk.** Claude runs with
`--dangerously-skip-permissions`, which is only acceptable because the container
is isolated and its egress is restricted to a whitelist. Planned (#9).

**The Claude token is an OAuth token.** Instances get `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token`. An `ANTHROPIC_API_KEY` is deliberately never set -- it
would override the subscription and bill per token.

## Order of work

Packages #2 to #5 produce the first walking skeleton: start an instance, use its
console in the browser. #2 and #3 are done -- an instance can be started and
removed over REST, the console still needs `docker exec`. #6 to #9 make it usable
in practice. See issue #1.
