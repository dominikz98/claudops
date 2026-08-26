# A browser WebSocket cannot set a header, so the credential is a cookie

**Fact.** The browser's `WebSocket` constructor takes a URL and a subprotocol
list -- nothing else. A cookie is therefore the only credential the SPA can send
on the terminal upgrade, and that is why the login is a cookie session rather
than a bearer token. The `ws` library used by the server tests and by
`scripts/ws-probe.ts` *can* set headers, which is why they take a `--cookie`.

**Why the alternatives lost.** A token in the query string
(`?token=...`) lands in `request.url`, which Fastify's default request serialiser
logs on every line -- and issue #9's own third criterion is that a grep over the
logs finds no tokens. `Sec-WebSocket-Protocol` is the one header a browser will
set, but it is logged like any other header, cannot be `HttpOnly`, and the server
would have to echo it back to complete the handshake.

**The gate reaches the upgrade.** Verified against `@fastify/websocket@11.3.0`: a
root `app.addHook('onRequest', ...)` that replies 401 fails the handshake with a
plain HTTP 401 and the `websocket: true` handler never runs. So there is no
`4401` close code in `terminal/protocol.ts` and no in-handler check -- a close
code nothing can send would be a lie in the file that documents the wire format.
The cost is that the browser can only report a refused handshake as close 1006
("connection lost"); in practice the console's own `GET /instances/:id` answers
401 at the same moment and the SPA redirects to `#/login` before that status line
matters.

**Applies to.** `server/src/auth/session.ts`, `server/src/auth/gate.ts`,
`server/src/terminal/routes.ts`, `web/src/terminal/session.ts`,
`server/scripts/ws-probe.ts`, issue #9.
