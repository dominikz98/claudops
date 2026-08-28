# `tmux send-keys` needs the pane, not the session -- and a pause before Enter

**Fact.** Typing into an instance goes to `-t <session>:0.0`, and the Enter is a
second `send-keys` after a pause (`SEND_KEYS_PAUSE_MS`, 400 ms). The text itself
travels as an argument with `-l`, never inside a `sh -c` string.

**Why.** Three separate traps, each of which looks like "the switch did nothing":

- **`-t <session>` means "wherever the session is focused."** Open a second
  window from the console -- the e2e suite does exactly that with its probe
  window -- and the slash command lands there instead of in Claude. `:0.0` is the
  pane `tmux new-session` created in the entrypoint, and it stays that as long as
  `docker/base/tmux.conf` leaves `base-index` at 0.
- **An Enter in the same read as its text is swallowed.** The TUI reads input in
  chunks, and the line then sits in the prompt unsent, looking exactly like a
  command that was ignored.
- **`-l` keeps tmux from reading `/model` as a key name**, and passing the line
  as an argument rather than interpolating it into a shell script means nothing
  about its content has to survive quoting. The same trick carries the values into
  the override files: `sh -c '... > ~/.claudops/model' sh "$model"`, not string
  concatenation.

**Applies to.** `server/src/instances/service.ts` (`sendLine`,
`overrideCommand`), `e2e/tests/instance.spec.ts`, issue #16.
