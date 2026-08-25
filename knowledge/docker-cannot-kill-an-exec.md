# Docker cannot kill an exec, so the terminal has to ask it to leave

**Fact.** Closing the hijacked stream of a `docker exec` does **not** end the
process. `tmux attach` keeps running with its TTY attached, and every reconnect
adds another client. The terminal bridge therefore writes `C-b d` (`0x02 0x64`,
tmux's default detach binding) into the stream before destroying it --
`AttachTerminalOptions.closeInput`, set by `InstanceService.openTerminal`.

**Why.** The Docker API has no "kill exec" endpoint, and it does not close the
pty when the client disconnects. Measured against a real daemon: after
`stream.end()` and after `stream.destroy()` the client was still listed by
`tmux list-clients`; only the detach sequence made it disappear. The consequence
of leaking one is not academic -- `aggressive-resize` sizes the window to the
attached client, so a stale 80x24 client from a closed browser tab shrinks the
pane for whoever is still watching, and the pty and process stay for the life of
the container.

The same measurement cleared `exec.resize` of suspicion: `POST /exec/<id>/resize`
does reach the pty and tmux follows it. Its only failure mode is an exec that has
already ended, which Docker answers with an error the bridge logs and drops.

The cost of the detach approach is a dependency on the prefix key.
`docker/base/tmux.conf` deliberately leaves it at `C-b`; a project image (#7)
that rebinds it would leak clients again.

**Applies to.** `server/src/docker/dockerode-engine.ts`,
`server/src/instances/service.ts` (`TMUX_DETACH`), `docker/base/tmux.conf`,
issue #4. The smoke test proves it: "No client stayed attached after the socket
closed" in `server/terminal-smoke-test.sh`.
