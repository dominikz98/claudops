# A failed clone must not kill the container

**Fact.** When `git clone` fails, the entrypoint logs the error and starts the
tmux session in `$WORKSPACE_DIR` anyway. It does not exit non-zero.

**Why.** A failed clone is the case you most want to look at -- wrong PAT, wrong
branch, repo renamed. A container that exits on it is no longer reachable through
the terminal bridge, so the diagnosis would have to happen through the docker logs
of a dead container. Two neighbouring decisions have the same motive: the session
starts detached, because the server starts the container without a TTY and
attaches later; and the pane runs Claude followed by `exec bash -l`, so an `/exit`
inside Claude leaves the session -- and the container -- alive.

**Applies to.** `docker/base/entrypoint.sh`, issues #3, #8.
