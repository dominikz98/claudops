# A WebSocket route must pause the socket while it is still setting up

**Fact.** `ws` drops an incoming frame that arrives before a `message` listener
exists -- it is an EventEmitter, and an event with no listener goes nowhere. The
upgrade completes before `/instances/:id/terminal` has finished attaching to
Docker, so the terminal route calls `socket.pause()` on entry and
`socket.resume()` in a `finally`.

**Why.** A browser sends its geometry from the `open` handler, which lands
exactly in the gap between the upgrade and the attach -- one Docker round trip
wide. What follows is not an error anywhere: the console renders at 80x24, the
first keystrokes vanish, and nothing is logged. `pause()` holds those frames in
the socket instead of the event loop, so they are delivered in order once the
bridge is wired.

Found the hard way: the only smoke test connection without `?cols=&rows=` was
also the only one that sent immediately after opening, and it looked like a
Docker problem for a while.

**Applies to.** `server/src/terminal/routes.ts`, and any future WebSocket route
that awaits anything before wiring its handlers. Regression test: "keeps a frame
the client sends the moment the socket opens" in `server/test/terminal.test.ts`.
