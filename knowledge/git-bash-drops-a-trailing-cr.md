# Git Bash loses a trailing CR from a command substitution

**Fact.** `arg="text$(printf '\r')"` yields `text` without the carriage return on
the Windows dev host. Anything that has to send a real CR through a shell
argument must produce it on the other side: `server/scripts/ws-probe.ts` has
`line:`/`textline:` steps that append the CR themselves, instead of the smoke
test building it.

**Why.** Command substitution strips trailing newlines, and Git Bash/MSYS counts
CR among them. The failure is silent and points elsewhere: the keystrokes arrive,
the shell echoes them, and the command simply never runs -- which reads as "the
terminal bridge delivers input but the container ignores it". Hunting that took a
container, a pane dump and a hand-run probe to notice that only the last byte was
missing.

**Applies to.** `server/terminal-smoke-test.sh`, `server/scripts/ws-probe.ts`,
and any future test that types into a terminal from bash. Related:
[The dev host is Windows, the target is Linux](windows-dev-host-linux-target.md).
