# A model switch has to reach two places, and one of them is a file

**Fact.** `InstanceService.setModelEffort` writes `~/.claudops/model` and
`~/.claudops/effort` in the container *and* types `/model` / `/effort` into its
tmux session, before it touches the database. The entrypoint prefers those files
over `CLAUDE_MODEL` / `CLAUDE_EFFORT`. An **empty** file means "no flag"; a file
that is not there falls back to the environment.

**Why.** Docker cannot change the environment of a container that already exists.
`docker stop` plus `start` runs the entrypoint again with the variables the
instance was *created* with, so a switch that only reached the running session
would quietly revert on the next restart while the instance list kept showing the
new model. The recreate-the-container alternative loses the workspace, which is
the one thing stop/start exists to keep.

Empty rather than removed is the other half: a removed file would fall back to
the environment, and the environment still carries the create-time value -- so
"back to Claude Code's default" would come back as the old model.

The order is Docker first, database last. A row that claims a model the container
was never told is the failure mode with no way back; an exec that failed after
the files were written is one the next switch fixes.

**Applies to.** `server/src/instances/service.ts`, `docker/base/entrypoint.sh`,
`docker/base/smoke-test.sh` (the restart assertions), issue #16.
