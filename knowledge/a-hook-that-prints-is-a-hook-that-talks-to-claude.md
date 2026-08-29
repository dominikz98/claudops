# A hook that prints is a hook that talks to Claude

**Fact.** `claudops-status` starts with `exec >/dev/null` and
`trap 'exit 0' EXIT`, before it reads anything. Both lines are load-bearing.

**Why.** A `UserPromptSubmit` hook's stdout is *added to the conversation as
context* -- so a line of curl progress, a shell warning, or a stray `set -x`
would arrive as text Claude reads and acts on. And exit code 2 from that same
hook blocks the prompt and erases what the user typed: a status report that
cannot reach its server would eat the user's message. Neither failure looks like
a hook problem from the console; the first looks like Claude hallucinating, the
second like a broken terminal.

The stdout rule is per event -- `Notification`, `Stop` and `SessionEnd` discard
it -- but one script serves all four, so it holds to the strictest of them.

**And it drains stdin before it decides anything.** Claude Code writes the
hook's JSON into the process; a script that exits on a guard before reading it
hands the writer an EPIPE. Every guard here is a reason to send nothing, and
none of them is a reason to break the pipe -- so `hook="$(cat)"` comes first and
the guards work on the string. It showed up as an intermittent unhandled error
in `server/test/hook-script.test.ts`, only under the load of the full suite,
which is the shape this class of bug has.

**Why the timeouts are curl's.** `SessionEnd` hooks share a budget of a second
and a half between them, and raising a hook's own `timeout` raises that budget.
So the script sets none and lets `--connect-timeout 1 --max-time 2` be the limit:
reporting is best-effort, and a server that hangs must not hold up a turn.

**Applies to.** `docker/base/claudops-status`,
`docker/base/claude-settings.json`, `server/test/hook-script.test.ts`,
`docker/base/smoke-test.sh`, issue #17.
