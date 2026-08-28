# Operations

Running claudops day to day.

## The web UI

<http://localhost:8080> -- the same port as the API. The instance list refreshes
itself every three seconds with the status Docker reports; **Console** opens the
tmux session of an instance, **Stop** and **Start** put its container down and
up again without touching the instance, and **Delete** asks twice and then takes
the container and its volumes with it. A project whose image is not built yet
cannot be picked in the create form -- the option says which state it is in.

Next to the Docker status stands a second badge, the *session*: a container is
`running` from the moment it starts, but its Claude session only exists once the
entrypoint has installed the egress firewall and cloned the repository. **Console**
stays disabled until that badge says `ready`, because until then there is nothing
to attach to. See [Is the session up](#is-the-session-up).

**Projects** in the top right manages the templates instances are created from.
Each row carries the state of its image, with **Rebuild** and **Build log** next
to it. The page normally does not poll, because nothing but this page changes a
project; while a build is running it refreshes every two seconds, because then the
server does -- and an open build log is re-read on the same beat, so the output of
a running build grows on the page instead of appearing only when it ends.

The UI is behind a shared secret. The first page you get is a login form; it
takes `CLAUDOPS_LOGIN_SECRET` and leaves a session cookie that lasts twelve
hours and renews itself while you keep using it. **Log out** is in the header of
the instance list. Everything is behind it -- the pages, the REST API and the
console WebSocket -- except `/health`, which has to answer without a credential
so a monitor or a smoke test can use it.

Two consequences worth knowing. The cookie is not `Secure` unless you set
`CLAUDOPS_SESSION_SECURE=1`, because the server speaks plain HTTP and a browser
silently discards a `Secure` cookie that arrived over it -- set it only with TLS
in front. And there is no session store, so logging out clears your own cookie
but cannot invalidate one somebody else copied; rotating
`CLAUDOPS_LOGIN_SECRET` and restarting is what ends every outstanding session at
once.

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
| `exited` | The container is stopped -- somebody pressed **Stop**, the tmux session ended, or `docker stop` was run by hand. **Start** brings it back with its workspace. |
| `missing` | The server has a row and Docker has no container. Either the container was removed by hand, or a create failed halfway. Only **Delete** is left; the next restart's reconcile is what sets this status in the first place. |

A container in `docker ps` that is *not* in the instance list was started by
hand. It carries no `claudops.instance` label, so nothing below will find it.

## Is the session up

`running` says the container exists. Whether a console can attach to it is the
`session` field next to it, and it comes from the container's own healthcheck --
`tmux has-session`, every five seconds:

```bash
curl -s localhost:8080/instances | grep -o '"session":"[a-z]*"'
docker inspect -f '{{.State.Health.Status}}' claudops-<id>
```

| Session | Meaning |
| --- | --- |
| `starting` | The container is up and the entrypoint has not reached tmux yet: the firewall is being installed, or the repository is being cloned. **Console** is disabled. Normal for the first seconds; for a large repository, for minutes. |
| `ready` | The tmux session exists. **Console** is enabled, and this is the only state in which the terminal endpoint attaches. |
| `failed` | The check kept failing past its five-minute start period: the entrypoint never reached tmux. `docker logs claudops-<id>` says why. **Delete** and create again, or **Stop**/**Start** to let the entrypoint run once more. |
| `none` | There is no running container to ask -- the instance is `exited` or `missing`. |

An instance started from a project image built before this existed carries no
healthcheck. It reports `ready` as soon as its container runs, which is the
behaviour that preceded the field; rebuild the project image to get the real
answer.

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

## Stop, start and remove

Stopping keeps the instance and everything in its container:

```bash
curl -s -X POST localhost:8080/instances/<id>/stop
curl -s -X POST localhost:8080/instances/<id>/start
```

A stop takes about a second -- SIGTERM, and the entrypoint shuts tmux down
cleanly. If it takes ten, SIGTERM is not being handled and Docker had to kill the
container: that is a bug, not a slow shutdown. `docker stop claudops-<id>` by hand
does the same thing; the list follows either way, because the status comes from
Docker.

A start runs the entrypoint again. The workspace, the clone and the git state are
where they were; the tmux session and Claude are new, and the clone step finds the
repository already there. What was only in memory is gone -- an unsaved Claude
conversation included.

Removing takes the container with it:

```bash
curl -s -X DELETE localhost:8080/instances/<id>     # container, volumes, row
```

That includes the container's anonymous volumes and any volume carrying the
instance's label, so uncommitted work in the workspace is gone for good.

A stopped instance is the cheap state: it holds disk, but no CPU and no memory.
Deleting is for an instance you are finished with.

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

## Attach a file to an instance

Three ways, all of them the same request underneath. In the console: the
**Attach** button, dropping a file onto the terminal, or pasting a screenshot
from the clipboard with `Ctrl-V`. Each one uploads the file, and the server then
types its path into the session -- so it stands in Claude's prompt with the
cursor behind it. Write the question after it and press Enter.

From a shell, without the browser:

```bash
curl -s -b cookies.txt -X POST --data-binary @screenshot.png \
  -H 'content-type: application/octet-stream' \
  'http://localhost:8080/instances/<id>/files?name=screenshot.png'
```

Everything lands in `/workspace/.claudops/uploads/` inside the container, next
to the clone rather than in it:

```bash
docker exec claudops-<id> ls -l /workspace/.claudops/uploads
```

That is deliberate. The clone is `/workspace/<repo>`, so an attachment is never
part of the repository, never shows up in its `git status` and cannot be
committed by accident. It is also not a safe place to keep anything: the
directory lives in the container's own layer, and a **Delete** takes it along.

Two ceilings, both set on the server:

| Variable | Default | What it limits |
| --- | --- | --- |
| `CLAUDOPS_UPLOAD_MAX_FILE` | `25m` | One attachment |
| `CLAUDOPS_UPLOAD_MAX_TOTAL` | `200m` | Everything one instance holds |

A file over either of them answers `413` with a message naming the limit, and
the console shows that message in red. Nothing is written, and the server keeps
running -- an oversized body is refused before it is read. What an instance
holds is read out of the container on every upload, so deleting attachments in
the console frees the budget straight away:

```bash
docker exec claudops-<id> rm /workspace/.claudops/uploads/old-screenshot.png
```

## Troubleshooting

**The console is empty or Claude is not running.** Attach and look. The pane runs
Claude followed by a login shell, so if Claude exited you land in bash with the
session still alive. `docker logs` shows whether the clone worked.

**The console closes immediately.** The close code says why: `4404` no such
instance, `4409` the container cannot be attached to, `4503` the Docker daemon is
unreachable. The error frame before the close names the case: `not_running` for a
stopped container, `no_container` for an instance whose container is gone, and
`session_not_ready` for one whose tmux session is not up -- which is what the
disabled **Console** button in the UI is about. `wscat` prints both.

**The console closed by itself after `Ctrl-P Ctrl-Q`.** That is Docker's own
detach sequence for an exec, and it takes the connection down before the bytes
reach tmux. Nothing is lost -- reconnect and the session is where it was.

**The pane is suddenly 80x24 and text wraps wrongly.** Something is attached at
that size: another console, or a leftover client from a browser that went away
without closing the socket. `tmux list-clients` names them, `tmux detach-client`
removes them.

**An attachment did not appear in the prompt.** The answer of the upload says
whether it was typed: `"announced": false` means the file is in the container
but the session was not up to type into. Wait for `session: ready` and attach it
again, or type the path by hand -- the file is at the `path` the answer names
either way.

**An attachment was refused with 413.** Either the file is over
`CLAUDOPS_UPLOAD_MAX_FILE`, or the instance's uploads directory is full. The
message says which; `docker exec claudops-<id> du -sh /workspace/.claudops/uploads`
is the other half of the answer.

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

**Stop or start answers 409 `container_missing`.** The instance is listed as
`missing`: there is a row and no container, so there is nothing to stop or start.
Delete it and create a new one.

**An instance was killed and shows as `exited` with code 137.** That is the OOM
killer: the container went over its memory limit.
`docker inspect -f '{{.State.OOMKilled}}' claudops-<id>` confirms it. Either the
work needs more than the limit -- raise `CLAUDOPS_INSTANCE_MEMORY` and create the
instance again -- or something in it is running away.

**`DELETE /projects/<id>` answers 409.** Instances still point at that project,
running or exited. The message says how many; delete those first. A project is
never deleted out from under an instance.

## Resource limits

Every instance is created with a ceiling: two CPUs and four gigabytes of memory
by default, with swap capped at the memory limit so a container that runs away is
killed instead of paging the whole NUC to a standstill.

```bash
docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' claudops-<id>
docker stats                        # what they are actually using, live
```

`2000000000` NanoCpus is two cores; `4294967296` is four gigabytes. Both come
from the server's environment and apply to containers created after a restart:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDOPS_INSTANCE_CPUS` | `2` | As `docker run --cpus`: a ceiling on CPU time, not a pinning to particular cores. |
| `CLAUDOPS_INSTANCE_MEMORY` | `4g` | `512m`, `1.5g` or a plain byte count. Below `6m` the server refuses to start. |

An existing container keeps the limits it was created with -- Docker can change
them in place, claudops does not:

```bash
docker update --cpus 4 --memory 8g claudops-<id>    # until that container is gone
```

Three instances at four gigabytes each on a 16 GB NUC is the sizing this default
assumes: they are not all busy at once, and the server itself needs room. Lower
the numbers before adding a fourth, and stop the instances nobody is using -- a
stopped container costs nothing but disk.

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

The normal path is `DELETE /instances/<id>`. Everything else is cleaned up by the
reconcile that runs once every time the server starts:

| What it finds | What it does |
| --- | --- |
| A container carrying `claudops.instance` that no instance points at | Removes it, with its volumes |
| A volume whose instance does not exist any more | Removes it |
| An instance whose container Docker does not have | Keeps the row, forgets the container, sets the status to `missing` |

So the answer to "the server was killed and there are containers nobody wants" is
to restart the server and look again. What it did is one log line:

```
INFO: startup reconcile  removedContainers=[...] removedVolumes=[...] endedInstances=[...]
```

A leftover it could not remove -- a volume another container still has mounted --
is a warning next to it and is tried again on the next restart. If Docker is
unreachable at startup the pass is skipped entirely and says so; nothing else
about the server depends on it.

The row of a `missing` instance is deliberately kept: it is somebody's instance,
and only its container is gone. Delete it when you are sure, which is also what
clears any volume it still owns.

By hand, the label is what to look for -- and the check to run before removing
anything, because a running instance means somebody has a Claude session in it:

```bash
docker ps -a --filter label=claudops.instance
docker volume ls --filter label=claudops.instance
docker images --filter label=claudops.project
```

Project images are the one thing the reconcile does not touch: deleting a project
removes its image, and an image left behind after a failed delete is `docker rmi`
material -- check that no instance still runs on it first.

## An instance cannot reach a host

Egress inside an instance is default-deny: it reaches the whitelist and nothing
else. When a tool inside a container hangs on a download or reports a refused
connection, that is usually why.

Start with the state file and the log:

```bash
docker exec <container> cat /run/claudops-firewall.state
docker logs <container> 2>&1 | grep '^\[firewall\]'
```

The first line of the state file is one word:

| State | Meaning |
| --- | --- |
| `active` | The firewall is up. Everything the log listed with a `+` is reachable, nothing else. |
| `failed` | Setup did not finish, so the container was sealed to loopback. Claude was not started. |
| `unfiltered` | Not even the seal was possible -- almost always a missing `--cap-add=NET_ADMIN`. Egress is **not** restricted, and Claude was still not started. |

For a host that is genuinely needed, add it to the server's
`CLAUDOPS_FIREWALL_ALLOW` (comma- or space-separated hosts and CIDRs), restart
the server and **recreate the instance** -- the whitelist is read once at
container start, so an existing container keeps the one it came up with.

A host that worked and then stopped is usually a CDN whose addresses rotated. The
container re-resolves its whitelist every 15 minutes for exactly that; a shorter
interval is `FIREWALL_REFRESH_SECONDS`.

`FIREWALL_MODE=off` turns the firewall off for a container entirely. It is the
last resort, not a workaround: it is also what makes
`--dangerously-skip-permissions` unsafe, so use it to prove a diagnosis and then
put the host on the whitelist instead.
