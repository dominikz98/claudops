# A smoke test has to wait for the state it asserts on, not for a sign of it

**Fact.** Two waits in the smoke tests looked correct and were not, and both
failed only on a busy host -- which is exactly the run you least want to
re-read:

- `server/smoke-test.sh` waited for `/workspace/claudops/.git` to exist and then
  asked for the branch. Git creates that directory at the *start* of a clone and
  writes `HEAD` at the end, so the answer came back as the literal `HEAD` and
  read like a container that had ignored `REPO_BRANCH`. It now waits for the
  branch itself and asserts on the value it waited for.
- `server/terminal-smoke-test.sh` waited for `tmux has-session` and then
  connected. Since #25 the bridge refuses an attach until the container's
  *healthcheck* has reported the session, and that check runs every five
  seconds -- so tmux is up several seconds before an attach is allowed. The
  connect landed in that window, the socket closed with `session_not_ready`, and
  eleven assertions read an empty screen. It now polls `GET /instances/:id`
  until `session` is `ready`, which is the same question the bridge asks.

**Why.** Both waits were for something that appears *on the way* to the state
the assertion needs, and both gaps are microseconds on an idle machine. The
result is a gate that is green until the day it matters, and a failure that
points at the feature rather than at the wait. The rule that catches both: wait
for the value you are about to assert on, and assert on the value you waited for.

Related: [Running is not attachable](session-readiness-comes-from-the-container.md)
is the same distinction from the server's side.

**Applies to.** `server/smoke-test.sh`, `server/terminal-smoke-test.sh`, and any
new wait loop in a smoke test.
