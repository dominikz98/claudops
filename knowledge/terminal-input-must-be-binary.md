# The browser must send keystrokes as binary frames, never as text

**Fact.** `server/src/terminal/protocol.ts` reads every text frame as a possible
JSON control message first and only falls back to treating it as input when the
parse fails or the result is not an object. A real client therefore sends
keystrokes as **binary** frames and reserves text frames for control messages --
`web/src/terminal/session.ts` encodes with `TextEncoder` for input and
`JSON.stringify` only for a resize.

**Why.** The text-frame fallback exists so `wscat` is a usable test client: type
`ls` there and `ls` is typed in the container. The cost is that a text frame
which *is* a JSON object is never input. Send keystrokes as text and pasting
`{"type":"resize","cols":1,"rows":1}` -- or any JSON at all -- into Claude
silently resizes the pane or produces an `invalid_message` notice instead of
appearing in the terminal. Nothing logs an error; the characters simply never
arrive.

**Applies to.** `web/src/views/console.ts` (`onData`, `onBinary`),
`web/src/terminal/session.ts`, `server/src/terminal/protocol.ts`. Any other
client written against this bridge has the same obligation.
