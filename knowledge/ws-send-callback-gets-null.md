# The ws send callback reports success as `null`, not `undefined`

**Fact.** `socket.send(data, options, cb)` calls `cb(null)` when the frame went
out, even though `@types/ws` types the parameter as `err?: Error`. Code that
branches on `err !== undefined` therefore treats every successful frame as a
failure.

**Why.** The terminal bridge uses that callback for backpressure: it pauses the
TTY stream per frame and resumes when the frame is out. With the `!== undefined`
check the resume never ran, so exactly one chunk reached the browser and the
console froze -- the initial redraw arrived, then nothing. Keystrokes still
travelled the other way, which made it look like a Docker or tmux problem rather
than a lost `resume()`. The bridge now resumes unconditionally and only logs the
error, so a dead socket costs a log line instead of a wedged stream.

The type is not lying about the underlying value: Node's writable streams call
their write callback with `null` on success, and `ws` passes that straight
through.

**Applies to.** `server/src/terminal/bridge.ts`. Regression test: "keeps piping
after the first frame" in `server/test/terminal.test.ts` -- one chunk proves
nothing, it takes a second one to see the missing resume.
