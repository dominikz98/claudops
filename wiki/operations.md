# Operations

Running instances by hand, until the server takes over (#3, #8).

## Look around

```bash
docker ps --filter label=claudops.instance          # instances started by the server
docker logs my-instance                             # entrypoint output: clone, session start
docker exec my-instance tmux list-sessions          # is the session alive
docker exec my-instance tmux capture-pane -p -t main:0.0   # what does Claude show right now
```

`capture-pane` is the read-only look at the console: it prints the pane without
attaching, so it cannot disturb a session someone else is using.

## Stop and remove

```bash
docker stop my-instance     # SIGTERM, the entrypoint shuts tmux down cleanly
docker rm -f my-instance
```

A stop takes about a second. If it takes ten, SIGTERM is not being handled and
Docker had to kill the container -- that is a bug, not a slow shutdown.

## Troubleshooting

**The console is empty or Claude is not running.** Attach and look. The pane runs
Claude followed by a login shell, so if Claude exited you land in bash with the
session still alive. `docker logs` shows whether the clone worked.

**The clone failed.** The container comes up anyway, on purpose -- the session
starts in `/workspace` so you can attach and see the cause. Usual suspects: wrong
or expired PAT, branch does not exist, repository renamed. `docker logs
my-instance` has the git error, with any credentials redacted.

**`tmux attach` says "terminal does not support clear".** The exec is missing a
TTY. Use `docker exec -it`, or pass `-e TERM=xterm-256color`.

**Claude asks for authentication.** `CLAUDE_CODE_OAUTH_TOKEN` was not passed in or
has expired. Mint a new one with `claude setup-token`.

**The container exits right after start.** The tmux session ended, which is what
the entrypoint watches for. `docker logs` shows the last line before the exit.

## Resource limits

Not enforced yet. Until #8 lands, an instance can use as much CPU and memory as
the NUC has, so start them one at a time when you are trying things out. Manual
limits work in the meantime:

```bash
docker run -d --cpus 2 --memory 4g ... claudops-base
```

## Cleaning up leftovers

Until the startup reconcile exists (#8), orphaned containers and volumes have to
go by hand:

```bash
docker ps -a --filter label=claudops.instance
docker volume ls --filter label=claudops.instance
```

Check the list before removing anything -- a running instance means somebody has a
Claude session open in it.

## Not there yet

Egress firewall and UI login (#9), automatic recycling and limits (#8), and
anything to do with the server or the web UI (#3 to #7).
