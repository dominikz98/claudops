# tmux writes an underscore for every multi-byte character unless the client says UTF-8

**Fact.** tmux decides per client whether it may emit UTF-8, from `LC_ALL`,
`LC_CTYPE` or `LANG` -- or from the global `-u` flag. `node:22-bookworm` sets
none of them (`LC_CTYPE=POSIX`), so a `tmux attach` through `docker exec`
counted as a non-UTF-8 client and every character above U+007F arrived as `_`.
Two things fix it, and both are in place: `claudops-base` sets `LANG=C.UTF-8`,
and the bridge attaches with `tmux -u attach`.

**Why.** The pane content itself was always correct --
`tmux capture-pane` showed `❯` and `✔` -- so this looks like a client-side
rendering or font problem for as long as you only look at the browser. It is
neither: the substitution happens in the tmux server on the way to the client,
and the bytes that reach xterm really are `0x5F`. The symptom only shows up with
something that draws a UI: an ASCII smoke test passes happily, while Claude's
whole first-run screen turns into rows of underscores.

`-u` in the bridge and `LANG` in the image overlap on purpose. The image fixes
every path, including a hand-run `docker exec -it claudops-<id> tmux attach`;
the flag keeps the bridge correct against a project image (#7) that forgets the
locale.

**Applies to.** `docker/base/Dockerfile`, `server/src/instances/service.ts`
(`openTerminal`). Regression test: the e2e console assertions in
`e2e/tests/instance.spec.ts` check a box-drawing character survives the trip.
Not to be confused with
[xterm-write-bytes-not-strings.md](xterm-write-bytes-not-strings.md), which is
the same symptom from a different cause -- decoding frames one at a time gives
U+FFFD, not `_`.
