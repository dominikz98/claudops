# Operations

Running claudops day to day. Automatic recycling and resource limits are still
to come (#8).

## The web UI

<http://localhost:8080> -- the same port as the API. The instance list refreshes
itself every three seconds with the status Docker reports; **Console** opens the
tmux session of an instance, **Delete** asks twice and then takes the container
with it. A project whose image is not built yet cannot be picked in the create
form -- the option says which state it is in.

**Projects** in the top right manages the templates instances are created from.
Each row carries the state of its image, with **Rebuild** and **Build log** next
to it. The page normally does not poll, because nothing but this page changes a
project; while a build is running it refreshes every two seconds, because then the
server does.

There is no login yet (#9), so anyone who can reach the port can start and delete
instances and type into every console. Keep it on a trusted network or behind a
reverse proxy until then.

A page that shows the list but never fills it means the API is answering with an
error -- the red banner names it. If the browser shows the JSON of an endpoint
instead of a page, the UI was not built: `pnpm build`, or point
`CLAUDOPS_WEB_ROOT` at an existing `web/dist`. The server says so at startup:

```
WARN: no built web UI found -- serving the API only
```

## Is the server healthy

```bash
curl -s localhost:8080/health
```

`{"status":"ok","docker":"ok"}` means the process is up and the Docker daemon
answers. `503` with `"docker":"unreachable"` means the server is running but
cannot start or list anything -- check the daemon before looking anywhere else.
The server deliberately starts even when Docker is down, so this is a real
state, not a hypothetical one.

## Look around

```bash
curl -s localhost:8080/projects                     # the templates, with their instance counts
curl -s localhost:8080/projects/<id>/build-log      # the output of its last image build
curl -s localhost:8080/instances                    # what the server knows, with live status
docker ps --filter label=claudops.instance          # what Docker has
docker images --filter label=claudops.project       # the project images claudops built
docker logs claudops-<id>                           # entrypoint output: clone, session start
docker exec claudops-<id> tmux list-sessions        # is the session alive
docker exec claudops-<id> tmux list-clients -t main # who is watching the console
docker exec claudops-<id> tmux capture-pane -p -t main:0.0   # what does Claude show right now
```

`capture-pane` is the read-only look at the console: it prints the pane without
attaching, so it cannot disturb a session someone else is using.

`list-clients` should show one line per open console. A line with nobody on the
other end is a leftover, and it matters: tmux sizes the window to its attached
client, so a stale 80x24 entry shrinks the pane for whoever is actually working.
Send it away by hand:

```bash
docker exec claudops-<id> tmux detach-client -t /dev/pts/3
```

The two lists should agree. Where they do not, the status says which way:

| Status | Meaning |
| --- | --- |
| `running` | Normal. |
| `exited` | The container stopped -- tmux session ended, or somebody ran `docker stop`. The instance still exists and can be deleted. |
| `missing` | The server has a row but Docker has no container. Either a create failed halfway, or the container was removed by hand. Deleting the instance clears the row. |

A container in `docker ps` that is *not* in the instance list was started by
hand. It carries no `claudops.instance` label, so nothing below will find it.

## Project images

The environment of a project is a prebuilt image, `claudops-project-<id>`. The
server builds it when the project is created and whenever its building blocks
change, and an instance cannot start before it is there.

```bash
curl -s localhost:8080/projects | grep -o '"status":"[a-z]*"'   # pending / building / ready / failed
```

| Status | What to do |
| --- | --- |
| `pending` | Nothing -- it is queued. Builds run one at a time. |
| `building` | Wait. A dotnet SDK plus a Chromium is a few minutes on the first build. |
| `ready` | Instances can be created. |
| `failed` | Read the build log, fix the cause, rebuild. |

```bash
curl -s localhost:8080/projects/<id>/build-log      # { status, builtAt, log }
curl -s -X POST localhost:8080/projects/<id>/build  # 202, rebuilds
```

A rebuild of an unchanged environment is seconds -- it comes off the layer cache.
The first build of a project with dotnet and Playwright is a few minutes and a few
hundred megabytes. Two projects with the same blocks share those layers.

Nothing rebuilds by itself except at startup, where a project left in `building`
by a killed server goes back into the queue. A `failed` build stays failed on
purpose: retrying a broken Dockerfile on every start would be a loop.

Deleting a project removes its image as well. An image left behind -- from a delete
where Docker was unreachable, say -- carries the label:

```bash
docker images --filter label=claudops.project
docker rmi claudops-project-<id>
```

Check nothing points at it first: an instance created from that project is still
running on it.

## Stop and remove

```bash
curl -s -X DELETE localhost:8080/instances/<id>     # container and row, in that order
```

This removes the container's anonymous volumes too, so uncommitted work in the
workspace is gone.

Only the container, keeping the instance:

```bash
docker stop claudops-<id>     # SIGTERM, the entrypoint shuts tmux down cleanly
```

A stop takes about a second. If it takes ten, SIGTERM is not being handled and
Docker had to kill the container -- that is a bug, not a slow shutdown. The
instance then lists as `exited`; there is no restart endpoint yet, so getting it
running again means deleting it and creating a new one.

## The console over the WebSocket

The browser uses `/instances/<id>/terminal`; so can anything else that speaks
WebSocket. The status line in the UI is the first diagnosis: `connected · 148×39`
names the geometry the container is being told about, and a `disconnected · ...`
line names the close code in words. Nothing reconnects on its own -- reload, or
press Reconnect.

Any WebSocket client will do:

```bash
npx wscat -c 'ws://localhost:8080/instances/<id>/terminal?cols=120&rows=40'
```

Typing works, and so does `Ctrl-b d` -- which detaches, ends that connection and
leaves Claude running, exactly like the `docker exec` route. The protocol and the
close codes are in [server/README.md](../server/README.md#terminal).

Two consoles on the same instance mirror each other; that is tmux, not a bug.
Both see the same pane, and the smaller window wins the size.

## Troubleshooting

**The console is empty or Claude is not running.** Attach and look. The pane runs
Claude followed by a login shell, so if Claude exited you land in bash with the
session still alive. `docker logs` shows whether the clone worked.

**The console closes immediately.** The close code says why: `4404` no such
instance, `4409` the container is not running (or there is no tmux session to
attach to), `4503` the Docker daemon is unreachable. `wscat` prints the code on
disconnect.

**The console closed by itself after `Ctrl-P Ctrl-Q`.** That is Docker's own
detach sequence for an exec, and it takes the connection down before the bytes
reach tmux. Nothing is lost -- reconnect and the session is where it was.

**The pane is suddenly 80x24 and text wraps wrongly.** Something is attached at
that size: another console, or a leftover client from a browser that went away
without closing the socket. `tmux list-clients` names them, `tmux detach-client`
removes them.

**The clone failed.** The container comes up anyway, on purpose -- the session
starts in `/workspace` so you can attach and see the cause. Usual suspects: wrong
or expired PAT, branch does not exist, repository renamed. `docker logs
my-instance` has the git error, with any credentials redacted.

**`tmux attach` says "terminal does not support clear".** The exec is missing a
TTY. Use `docker exec -it`, or pass `-e TERM=xterm-256color`.

**The console shows rows of underscores where Claude's boxes should be.** tmux
replaces every multi-byte character for a client that has not declared UTF-8.
`claudops-base` sets `LANG=C.UTF-8` and the bridge attaches with `tmux -u`, so
this only happens with a project image that dropped the locale, or with a
hand-run `docker exec` into such an image -- `tmux -u attach -t main` fixes that
one on the spot.

**Claude asks for authentication.** `CLAUDE_CODE_OAUTH_TOKEN` was not passed in or
has expired. Mint a new one with `claude setup-token`.

**The container exits right after start.** The tmux session ended, which is what
the entrypoint watches for. `docker logs` shows the last line before the exit.

**`POST /instances` answers 422 `project_image_not_ready`.** The project's image
is not built yet, is still building, or its build failed -- the answer carries
which. There is no fallback to installing the environment at container start, so
this is a wait or a fix, not a warning. `GET /projects/<id>/build-log` says what
happened.

**`POST /instances` answers 422 `image_not_found`.** The project says its image is
`ready` but Docker does not have the tag -- somebody ran `docker rmi`, or the
Docker root was wiped. `POST /projects/<id>/build` puts it back.

**A project image build fails with `pull access denied` or `not found`.** The base
image is missing: `docker build -t claudops-base docker/base`, or
`CLAUDOPS_BASE_IMAGE` names a tag that does not exist. The build never reaches a
registry -- `claudops-base` is local only.

**A project image build fails inside the dotnet or Playwright step.** The build
needs network access for `dot.net` and the Playwright download host. The log names
the step; a proxy or an offline NUC is the usual cause.

**`POST /instances` answers 503.** The Docker daemon is not reachable. No
instance was created -- the server rolls the row back rather than leaving a
half-created one behind.

**A request answers 400 for a field that looks right.** Unknown fields are
rejected rather than ignored, so a typo in `repoBranch` fails the request
instead of silently starting an instance on the default branch. The message
names the offending property. `POST /instances` in particular takes only `name`
and `projectId` -- `repoUrl` and `gitToken` moved to the project and are a 400
here.

**`POST /projects` answers 422 `secret_key_missing`.** The server has no
`CLAUDOPS_SECRET_KEY`, so it refuses to store a PAT rather than keeping it in the
clear. Set the key and restart; a project without a token works either way.

**`POST /instances` answers 422 `secret_undecryptable`.** The project's PAT was
encrypted with a different key than the one the server has now -- a rotated or
lost `CLAUDOPS_SECRET_KEY`. Nothing else breaks: enter the token again on the
project (or remove it) and the next instance starts.

**`DELETE /projects/<id>` answers 409.** Instances still point at that project,
running or exited. The message says how many; delete those first. A project is
never deleted out from under an instance.

## Resource limits

Not enforced yet. Until #8 lands, the server starts containers without limits, so
an instance can use as much CPU and memory as the NUC has -- create them one at a
time when you are trying things out. A hand-started container can be capped in
the meantime:

```bash
docker run -d --cpus 2 --memory 4g ... claudops-base
```

## The database

Projects and instance metadata live in the SQLite file named by `CLAUDOPS_DB`, by
default `data/claudops.db` next to wherever the server was started. It holds
identity, no status -- with one exception, the state and log of each project's last
image build, because a build that failed leaves no Docker object to ask -- and one
secret: the PAT of each project, encrypted with `CLAUDOPS_SECRET_KEY`. The file on
its own is therefore no use to anyone; the key is what makes it readable, so keep
the two apart in a backup.

Deleting the file loses the projects, and the names and creation times of running
instances -- but not the instances: their containers keep running and are still
findable by label. The project images stay on the host too; without their projects
nothing references them, so they are `docker rmi` material
(`docker images --filter label=claudops.project`).

Rotating the key is not a migration: the sealed PATs simply stop opening. Enter
them again on each project, and instance creation works from the next attempt.
The database runs in WAL mode, so a fresh write is in `claudops.db-wal` until
SQLite checkpoints it -- copy all three files or none.

```bash
docker ps -a --filter label=claudops.instance
```

## Cleaning up leftovers

The normal path is `DELETE /instances/<id>`. Until the startup reconcile exists
(#8), two cases still need hands:

- an instance listed as `missing` -- delete it, which clears the row
- a container with the label but no instance, from a create that died between
  the two steps

```bash
docker ps -a --filter label=claudops.instance
docker volume ls --filter label=claudops.instance
```

Check the list before removing anything -- a running instance means somebody has a
Claude session open in it.

## Not there yet

Egress firewall and UI login (#9), automatic recycling and limits (#8). Restarting
an instance is not an endpoint either; delete and create.
