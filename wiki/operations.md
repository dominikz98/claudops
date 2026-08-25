# Operations

Running claudops day to day. Automatic recycling and resource limits are still
to come (#8).

## The web UI

<http://localhost:8080> -- the same port as the API. The instance list refreshes
itself every three seconds with the status Docker reports; **Console** opens the
tmux session of an instance, **Delete** asks twice and then takes the container
with it.

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
curl -s localhost:8080/instances                    # what the server knows, with live status
docker ps --filter label=claudops.instance          # what Docker has
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

**`POST /instances` answers 422.** The base image is not built, or
`CLAUDOPS_BASE_IMAGE` names a tag that does not exist. `docker images
claudops-base` says which.

**`POST /instances` answers 503.** The Docker daemon is not reachable. No
instance was created -- the server rolls the row back rather than leaving a
half-created one behind.

**A request answers 400 for a field that looks right.** Unknown fields are
rejected rather than ignored, so a typo in `repoBranch` fails the request
instead of silently starting an instance on the default branch. The message
names the offending property.

## Resource limits

Not enforced yet. Until #8 lands, the server starts containers without limits, so
an instance can use as much CPU and memory as the NUC has -- create them one at a
time when you are trying things out. A hand-started container can be capped in
the meantime:

```bash
docker run -d --cpus 2 --memory 4g ... claudops-base
```

## The database

Instance metadata lives in the SQLite file named by `CLAUDOPS_DB`, by default
`data/claudops.db` next to wherever the server was started. It holds identity
only -- no status, no tokens. Deleting it loses the names and creation times of
running instances, but not the instances: their containers keep running and are
still findable by label.

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

Egress firewall and UI login (#9), automatic recycling and limits (#8), and
projects (#6, #7). Restarting an instance is not an endpoint either; delete and
create.
