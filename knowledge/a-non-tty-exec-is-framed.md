# A `docker exec` without a TTY hands back a framed stream, one with a TTY does not

**Fact.** `DockerodeEngine.runCommand` creates its exec with `Tty: false` and
therefore has to run the hijacked stream through `docker.modem.demuxStream`
before the bytes mean anything. `attachTerminal` right next to it creates its exec
with `Tty: true` and pipes the stream straight to the WebSocket. Both are
correct, and swapping either one is silent: the terminal would show framing
bytes, and `runCommand` would return output that looks almost right.

**Why.** With a TTY there is one output channel, so Docker hijacks the
connection and passes bytes through unchanged. Without one, stdout and stderr
share the connection and every chunk gets an eight-byte header --
`[stream_type, 0, 0, 0, size32]` -- so a reader that concatenates the chunks gets
the payload with binary interleaved into it. `demuxStream` is what dockerode
ships for exactly this.

The failure mode is what makes this worth a file. The upload path reads the
uploads directory with `find -printf '%s\n'` and sums the lines in Node. Fed a
raw framed stream, the first line begins with the frame header, `parseInt`
returns `NaN`, the filter drops it -- and the total comes out as *some* number
rather than as an error. The per-instance quota would then be enforced against a
figure that is too small, and nothing anywhere would say so.

It also explains why `Tty: false` is the right choice here despite the extra
work: only without a TTY does `exec.inspect()` give a meaningful `ExitCode`, and
`announced` on an upload is exactly that exit code. Related: `exec.inspect()` can
still report `Running: true` for a moment after the stream ended, so
`exitCodeOf` asks twice rather than reading a `null` exit code as success.

**Applies to.** `server/src/docker/dockerode-engine.ts` (`collectOutput`,
`runCommand`, `exitCodeOf`), `server/src/instances/service.ts`
(`usedUploadBytes`), issue #15. The smoke test proves the demultiplexing really
happened: "The third is over CLAUDOPS_UPLOAD_MAX_TOTAL" in
`server/smoke-test.sh` can only pass if the byte counts were read correctly.
See also [Docker cannot kill an exec](docker-cannot-kill-an-exec.md) for the
other half of the exec story.
