# "Running" is not "attachable" -- the container reports which

**Fact.** `GET /instances` carries two states, not one: `status`, the raw Docker
state, and `session`, one of `none | starting | ready | failed`. The second one
comes from a `HEALTHCHECK` in `docker/base/Dockerfile` that runs
`tmux has-session`, read back as `State.Health.Status`. The Console button is
enabled by `session === 'ready'` and by nothing else, and `openTerminal` refuses
`starting` and `failed` before it creates an exec.

**Why.** A container is `running` from the moment Docker starts it, and the
entrypoint then installs an egress firewall and clones a repository -- seconds
for a small repo, minutes for a large one. Everything in between is a Console
button that opens on nothing. The obvious alternative, "assume ready N seconds
after start", is wrong for every repository size at once; the container is the
only party that knows, so it is the one that answers.

Refusing *before* the exec is the point of the gate. `tmux attach` against a
session that does not exist exits non-zero, and by then the WebSocket upgrade
has already succeeded -- all the bridge can do is send `session_failed`, which
reads like a broken instance rather than one that is not up yet. The refusal
carries `session_not_ready` instead.

**Why the start period is five minutes.** A check that fails inside
`--start-period` keeps the container `starting` and does *not* count against
`--retries`; only after the period do failures accumulate into `unhealthy`. That
is what turns "the entrypoint never reached tmux" into a terminal state instead
of a permanent `starting` -- and it is also why the period has to cover the
slowest legitimate start there is, a large clone over a slow line, rather than a
typical one.

**Why a missing healthcheck reads as `ready`.** An image without one reports no
health at all, and Docker's answer for it is indistinguishable from "the check
has not run". Reading that as `starting` would disable the console of every
instance started from an image built before #25, with no way back short of
rebuilding the project and recreating the instance. `ready` degrades to the
behaviour that existed before the healthcheck did.

**Every harness has to wait for it, not for tmux.** `tmux has-session` inside
the container is true a few seconds before `session` is: the healthcheck runs
every five seconds, so there is a window in which the session exists and the
terminal endpoint still refuses. A test that polls the container directly and
then connects is closed with `session_not_ready` and reports something else --
`server/terminal-smoke-test.sh` did exactly that between #29 and #15 and failed
eleven checks that had nothing to do with the terminal. Wait on
`GET /instances/:id` reporting `session: ready`, which is what the browser does.

**Applies to.** `docker/base/Dockerfile`, `server/src/instances/service.ts`
(`SessionReadiness`, `SessionNotReadyError`), `server/src/terminal/routes.ts`,
`web/src/views/list.ts`, issue #25.
