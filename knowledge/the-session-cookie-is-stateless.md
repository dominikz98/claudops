# The session cookie is stateless, so logout is client-side only

**Fact.** A claudops session is an HMAC over an expiry, carried in
`claudops_session`. There is no session table and no server-side store, so
`POST /logout` clears the browser's cookie but cannot revoke the token: one that
somebody copied stays valid until it expires (12 hours, renewed past half-life).

**Why.** The entire session state is "valid until *t*", and a signed timestamp
says that without a table to sweep, a restart logging every browser out, or a
second thing to keep consistent with the database. For a shared secret on a LAN
that is the right trade: there is no account to lock and no per-user revocation
to offer, so a store would carry no information the token does not.

Hand-rolled with `node:crypto` for the same reason `secrets/cipher.ts` is:
`@fastify/cookie` is not in the tree, and `@fastify/secure-session` would add a
third native module to `pnpm-workspace.yaml`'s `onlyBuiltDependencies` allowlist
([pnpm-blocks-native-build-scripts.md](pnpm-blocks-native-build-scripts.md)) for
state that is one number.

Consequences to keep in mind if this ever needs to change: rotating
`CLAUDOPS_LOGIN_SECRET` is the only way to invalidate every outstanding session,
and it invalidates all of them at once, because both the comparison key and the
signing key are HKDF-derived from it.

**Applies to.** `server/src/auth/session.ts`, `server/src/auth/routes.ts`,
`wiki/operations.md`, issue #9.
