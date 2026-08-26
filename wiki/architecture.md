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

claudops-base -> docker/project + building blocks -> claudops-project-<id>
Container per instance: project image -> clone repo -> tmux -> claude
```

## Components

| Component | Role | State |
| --- | --- | --- |
| `claudops-base` | Base image: Node, Claude Code CLI, git, tmux, non-root user, entrypoint | Available |
| `claudops-server` | Fastify: project and instance REST, the image builds, the terminal bridge and the UI | Available |
| Project images `claudops-project-<id>` | One template Dockerfile plus the building blocks of a project, prebuilt | Available |
| Web UI | Vite SPA served by the server on the same port: projects, instance list and console | Available |
| SQLite | Metadata for projects and instances, the encrypted project PATs, the state of each image | Available |

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

**A project is the template, an instance is a copy of it.** Repository, branch,
building blocks and the git credential live on the project; creating an instance
takes a name and a project id and nothing else. What the container was told to
clone is written onto the instance as well, as a snapshot -- so editing a project
does not rewrite the history of an instance already running. A project cannot be
deleted while instances still point at it; the request answers `409` with the
count rather than leaving them without an origin.

**The project PAT is the one secret in the database, and it is encrypted.**
Everything else claudops handles passes straight through into a container and is
forgotten. A template has to outlive its instances, so its credential is stored
-- as an AES-256-GCM blob whose key comes from `CLAUDOPS_SECRET_KEY` and never
touches the database. The file on disk therefore holds no readable token, which
is what makes a copied database or a backup uninteresting. No response ever
carries the PAT back: a project reports only whether one is set. Without a key
the server still runs; it just refuses to store a PAT instead of keeping it in
the clear.

**Environments are prebuilt images.** A project defines its environment through
building blocks (dotnet, Playwright). The server builds `claudops-project-<id>`
from one template Dockerfile on top of `claudops-base` -- one layer per block, the
blocks passed as build args -- and instances start from that image. devcontainer
features were rejected: they install at container start, so every instance pays
the install time again and nothing is layer-cached. One template rather than a
generated Dockerfile per project is what lets two projects with the same
environment share their layers, which is why an unchanged rebuild takes seconds.

**A build is asynchronous, and instance creation waits for it.** A dotnet SDK plus
a Chromium is minutes of work, so `POST /projects` answers immediately with an
image that is `pending` and the build runs behind it, one at a time. The price of
prebuilding is that there is nothing to fall back to: until the image is `ready`,
creating an instance answers `422` and says which state the image is in. A failed
build keeps its log on the project, because a build that produced no image leaves
no Docker object to ask afterwards -- it is the one piece of state the database
holds that Docker does not. A restart requeues whatever was interrupted; a failure
waits for somebody to ask again, so a broken Dockerfile does not spin.

**Every resource is labelled.** Containers and volumes carry
`claudops.instance=<id>`, project images carry `claudops.project=<id>`. That is
what makes a complete delete and the startup reconcile possible -- and what
distinguishes an image claudops built from one somebody built by hand. Without
the label a container that outlived its instance would be indistinguishable from
a foreign one, and nothing could ever be removed automatically.

**Docker owns the state, SQLite owns the identity.** The instance table has no
status column. Every list request asks Docker for the state of the labelled
containers and joins it onto the rows, so a container somebody stopped by hand
shows as `exited` instead of as whatever the server last wrote down. An instance
whose container is gone reports `missing` rather than disappearing. Creating goes
row first, container second, and rolls the row back on failure -- a container
without a row would have no handle left to find it by.

**Cleaning up is a startup pass, not a poller.** Docker and the database can only
drift apart when something dies between two steps: a killed server, a `docker rm`
by hand, a create that failed after its container was up. Once, at startup, the
server removes the labelled containers and volumes no instance claims, and tells
the instances whose containers are gone that they are gone -- keeping their rows,
because a row is somebody's instance and deleting it behind their back is not
cleanup. Nothing runs periodically: the state comes from Docker on every request
anyway, so a background sweep would only race with whoever is using the UI. A
daemon that is down at startup skips the pass; a leftover survives one more
restart, which is cheaper than a server that refuses to start.

**An instance is capped, and stopping it is cheaper than deleting it.** Every
container is created with a CPU and a memory ceiling (two cores, four gigabytes
by default) and with swap capped at the memory limit, so an instance that runs
away is killed instead of paging the NUC to a standstill -- a handful of them
share one small box with the server itself. `stop` and `start` keep the container
and everything in it, so an instance nobody is using costs disk and nothing else;
`delete` is for one that is finished with, and takes the container and its
volumes.

**Isolation is what permits the risk.** Claude runs with
`--dangerously-skip-permissions`, which is only acceptable because the container
is isolated and its egress is restricted to a whitelist. The container installs
that whitelist on itself: the entrypoint runs `init-firewall.sh` before it clones
anything, which resolves a built-in host list plus GitHub's published ranges plus
the project's own repository host, then sets the default policy to DROP. The
container is created with `NET_ADMIN` for it, and one `sudo` entry inside the
image lets the unprivileged entrypoint reach `iptables`.

Two properties of it are worth knowing. **The docker bridge is not on the
whitelist**, so an instance can reach neither the claudops API on the gateway nor
its neighbours -- the terminal bridge is a `docker exec`, not a connection into
the container. And **the firewall is configured exactly once per container
start**: a re-run is refused, so the agent inside cannot widen its own whitelist.
If the firewall cannot be established, Claude is not started at all -- the
session comes up with a plain shell so the console still works for diagnosis.

**The UI is behind a shared secret.** `POST /login` exchanges
`CLAUDOPS_LOGIN_SECRET` for a session cookie, and one `onRequest` hook gates
every endpoint except `/health`, the login endpoints and the SPA shell itself --
which has to be public, because it *is* the login page. The cookie is the
credential rather than a bearer token because a browser cannot set a header on a
WebSocket upgrade, and the console needs to authenticate too.

**The Claude token is an OAuth token.** Instances get `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token`. An `ANTHROPIC_API_KEY` is deliberately never set -- it
would override the subscription and bill per token.

## Order of work

Packages #2 to #5 produce the first walking skeleton: start an instance, use its
console in the browser. All four are done -- an instance can be created, driven
and deleted from a browser page, and a refresh finds the session where it was.
#6 to #9 make it usable in practice, and all four are done: a repository and its
credential are configured once as a project, that project brings its own prebuilt
environment, an instance is capped, stoppable and cleaned up after, and #9 closes
the two holes that were left -- egress is default-deny and the UI needs a login.
See issue #1.
