# A hook that refuses a WebSocket upgrade has to destroy the socket itself

**Fact.** When a Fastify `onRequest` hook short-circuits an *upgrade* request
with a reply, the socket the answer goes out on is never released, and
`app.close()` waits for it forever. Neither `server.closeAllConnections()`,
`server.closeIdleConnections()`, `forceCloseConnections: true` nor a
`Connection: close` header reaches it. The session gate therefore does

```ts
if (request.headers.upgrade !== undefined) {
  reply.raw.on('finish', () => { request.raw.socket.destroy(); });
}
```

before it sends the 401.

**Why.** Node hands an upgrade request to its `'upgrade'` listener and stops
treating the socket as an ordinary request, so it falls outside every mechanism
that closes tracked HTTP connections -- but `server.close()` still will not
finish while it exists. `@fastify/websocket` destroys the socket for the refusals
it makes itself (its own 404 for a path with no websocket route closes cleanly),
so nothing covers a refusal from a hook above it.

**Why it matters beyond a test.** `src/index.ts` shuts down with
`await app.close()` on SIGTERM. Without this, one unauthenticated request to
`/instances/:id/terminal` -- a stale browser tab is enough -- would leave the
server unable to shut down, so `docker stop` would sit out its timeout and
SIGKILL it. Measured on `@fastify/websocket@11.3.0`; four scenarios distinguish
it: an accepted upgrade closes, an upgrade to a path with no websocket route
closes, a plain non-upgrade request refused by the hook closes, and only the
refused upgrade hangs.

**Applies to.** `server/src/auth/gate.ts`, `server/test/auth.test.ts` (the plain
`app.close()` in its `afterEach` is the regression test), and any future hook
that answers before a `websocket: true` route.
