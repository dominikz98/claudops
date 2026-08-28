# A warm prompt cache turns a model switch into a dialog, and claudops does not answer it

**Fact.** `/model` and `/effort` ask the user to confirm while Claude Code's
prompt cache is still warm -- one cache TTL since the last request or response.
claudops types the command and stops there. If a dialog appears, it waits in the
console for a human, and the session keeps its old model until then.

**Why.** The alternative is sending a second Enter blindly, and that is worse
than the problem: with no dialog on screen it submits whatever the user had
half-typed in the prompt. Detecting the dialog from `tmux capture-pane` would
mean matching prose from a TUI that is free to reword it, and a matcher that
silently stops matching turns into the same blind Enter.

What the switch *does* guarantee without any of that is what the ticket asked
for: no restart, no lost session, and the choice recorded for the next container
start. The confirmation is one keypress in a console that is already open.

Worth knowing when this bites: after a break longer than the cache TTL there is
no dialog at all, so a switch on an idle instance applies straight away, and a
test that only ever ran against idle sessions will not have seen the dialog once.

**Applies to.** `server/src/instances/service.ts` (`setModelEffort`),
`server/README.md`, `wiki/operations.md`, issue #16.
