# CLAUDE_CODE_EFFORT_LEVEL outranks `/effort`, so the start value has to be a flag

**Fact.** An instance's model and effort reach the container as `CLAUDE_MODEL`
and `CLAUDE_EFFORT`, which `docker/base/entrypoint.sh` turns into `--model` and
`--effort` on the `claude` start line. The two variables Claude Code reads
itself, `ANTHROPIC_MODEL` and `CLAUDE_CODE_EFFORT_LEVEL`, are deliberately not
used.

**Why.** `CLAUDE_CODE_EFFORT_LEVEL` takes precedence over *every* other way of
setting the level -- the flag, the setting, and `/effort` in the running session.
Setting it on the container would mean a switch from the UI is accepted, echoed
back, stored, and has no effect on a single request, with nothing anywhere saying
why. `ANTHROPIC_MODEL` is milder but the same shape: a model saved with `/model`
loses to it on the next launch, so the container would drift back on every
restart.

The CLI flags do not have that property. They are session-start values, and
`/model` and `/effort` are allowed to override them, which is exactly the layering
issue #16 needs: chosen at start, changeable while running.

Two smaller consequences of the same documentation:

- `--effort max` does not persist for Claude Code. That costs nothing here --
  every container start passes the flag again.
- `effortLevel` in `settings.json` accepts `low` to `xhigh` but not `max`, which
  is one reason claudops writes its own override files rather than that key.

**Applies to.** `server/src/instances/service.ts` (`envFor`),
`docker/base/entrypoint.sh`, `docker/base/README.md`, issue #16.
