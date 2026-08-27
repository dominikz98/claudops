# `playwright.request.newContext()` inherits `use.storageState`, so an "anonymous" API context is logged in

**Fact.** With `use.storageState` set in `playwright.config.ts`,
`playwright.request.newContext({ baseURL })` arrives carrying the saved session
cookie. Opting out takes an explicit empty jar:

```ts
playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
```

Measured on Playwright 1.62.1: the raw context reports
`cookies: ["claudops_session"]` and gets `200` from `/instances`; the same context
with the empty jar gets `401`.

**Why.** It is the opposite of what the fixture split suggests, so
`e2e/tests/auth.spec.ts` was written assuming a bare `newContext()` is anonymous
-- with a comment saying so. Every `401` assertion in it was therefore asserted
against a logged-in client, and the file's first test failed with `Expected: 401,
Received: 200` while the two later tests never ran at all: the describe block is
`mode: 'serial'`, so the first failure skips the rest, including a second
"unauthenticated" test that was broken in exactly the same way.

The failure reads as a hole in the login gate, which is the expensive part. It is
not: started by hand with `CLAUDOPS_LOGIN_SECRET`, the server answers `401` on
`/instances`, `/projects`, `/session` and `/nope` and `200` only on `/health`. The
quickest way to tell the two apart is the server's own log -- `buildApp` warns
"no login configured -- every endpoint is open" when `options.auth` is missing,
and the absence of that line clears the server.

Browser contexts have the same inheritance, which the file already handled with
its `anonymous(browser)` helper. The request half simply had no equivalent.

**Applies to.** `e2e/tests/auth.spec.ts`, `e2e/playwright.config.ts`,
`e2e/global-setup.ts`.
