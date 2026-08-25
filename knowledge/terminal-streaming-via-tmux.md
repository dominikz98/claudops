# Terminal streaming rides on tmux, not on an application buffer

**Fact.** The console is streamed as a raw binary duplex: dockerode `exec` with
`Tty: true` and `hijack: true` running `tmux attach -t main`, piped through `ws`
into xterm.js. The container starts the session with `tmux new -A -s main`, so
every reconnect attaches the same session.

**Why.** Reconnect, scrollback and "Claude keeps running while the browser is
closed" all fall out of tmux for free. The alternative -- keeping an output buffer
per instance in the server and replaying it on reconnect -- has to reimplement
terminal state (cursor, alternate screen, resize) that the Claude TUI actively
uses, and loses the running process the moment the server restarts. The first
geometry rides along on the exec create as `ConsoleSize`, later ones come as
cols/rows control messages to the exec resize API; tmux carries
`aggressive-resize on` so the pane follows the active client.

**Applies to.** `docker/base/entrypoint.sh`, `docker/base/tmux.conf`,
`server/src/terminal/`, issues #1, #4, #5. What it costs on the way out:
[Docker cannot kill an exec](docker-cannot-kill-an-exec.md).
