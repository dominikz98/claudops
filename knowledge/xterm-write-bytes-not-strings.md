# Hand xterm the raw bytes of a frame, never a per-frame decoded string

**Fact.** `terminal.write()` takes a `Uint8Array` as well as a string, and the
console passes the frame through untouched:
`socket.binaryType = 'arraybuffer'`, then `terminal.write(new Uint8Array(data))`.
Decoding each frame with `TextDecoder` first is wrong.

**Why.** The TTY stream is a byte stream, and Docker cuts it into frames wherever
the buffer happened to end -- a multi-byte UTF-8 sequence, a box-drawing
character in Claude's TUI or an emoji in a commit message, can be split across
two frames. A `TextDecoder` created per frame has no memory of the half sequence
and emits U+FFFD twice; xterm's own decoder keeps that state across writes, so
handing it the bytes is both simpler and correct. The same reasoning rules out
`Blob` frames: reading them is asynchronous, which reorders output.

**Applies to.** `web/src/views/console.ts`, `web/src/terminal/session.ts`. See
also [terminal-streaming-via-tmux.md](terminal-streaming-via-tmux.md) for why
there is no buffering anywhere else either.
