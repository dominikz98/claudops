# Architecture

claudops starts isolated Claude Code instances in Docker containers on an Intel
NUC and mirrors their consoles into the browser.

```
Browser (SPA + xterm.js) <=> HTTP + WebSocket <=> claudops-server (Node/TS)
                                                  |- static: the SPA itself
                                                  |- REST: projects and instances (SQLite)
                                                  |- WS: one TTY per console
                                                  |- dockerode -> Docker Engine
                                                  +- image builds per project

Container per instance: project image -> clone repo -> tmux -> claude
```

## Components

| Component | Role | State |
| --- | --- | --- |
| `claudops-base` | Base image: Node, Claude Code CLI, git, tmux, non-root user, entrypoint | Available |
| `claudops-server` | Fastify: instance REST, the terminal bridge and the UI; projects to come | Instance REST, terminal and UI available; #6 open |
| Web UI | Vite SPA served by the server on the same port: instance list and console | Available |
| SQLite | Metadata for instances; projects join it with #6 | Available |

## Decisions worth knowing

**The console rides on tmux.** The container starts Claude inside a tmux session.
The bridge attaches to it with `docker exec` on a TTY and pipes the raw stream to
xterm.js. That is what makes a browser refresh survivable: the session, the
scrollback and the running Claude are in the container, not in the server or the
browser. Every connection is its own exec and its own tmux client, so a reconnect
is a fresh attach rather than a replay -- the server keeps no output buffer at
all.

**Disconnecting has to be said out loud.** Docker has no way to kill an exec and
does not close the TTY when the client goes away, so a browser tab that closes
would leave its `tmux attach` running -- and because tmux sizes a window to its
attached client, a forgotten 80x24 client shrinks the pane for everyone else. The
bridge therefore sends tmux's detach sequence before dropping the stream, and
pings every 30 seconds so a client that vanished without saying goodbye is
noticed at all.

**One port, and the browser routes in the fragment.** The server serves the built
SPA at `/` next to its own API, so there is no second process, no second origin
and no CORS. The UI's own routes live in the hash (`#/i/<id>`) rather than in the
path, because `/instances/<id>` is already the REST resource -- a history route
would have to shadow the API or branch on the `Accept` header, and a catch-all
`index.html` would turn the JSON 404 into an HTML page for every mistyped API
call. A checkout where the UI was never built still starts: the server logs a
warning and serves the API alone.

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
console in the browser. All four are done -- an instance can be created, driven
and deleted from a browser page, and a refresh finds the session where it was.
#6 to #9 make it usable in practice. See issue #1.
