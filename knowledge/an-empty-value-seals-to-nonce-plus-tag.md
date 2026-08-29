# An empty value seals to exactly a nonce and a tag, and a `<=` guard refuses it

**Fact.** `SecretCipher.seal('')` produces a blob of exactly `IV_BYTES +
TAG_BYTES` -- twelve plus sixteen -- with no ciphertext after it. A length guard
written as "too short to hold a tag" (`length <= IV + TAG`) rejects that blob as
undecryptable, so an empty value can be stored and never read back.

**Why.** It only shows up once something legitimately stores an empty string. A
project PAT never does -- the service maps `''` to "no token" -- but an
environment variable does: a variable that exists and says nothing is a normal
thing to hand a program, and a `.mcp.json` asking for `${FLAG}` cares that the
name is set, not that it has content. The symptom is a `SecretUndecryptableError`
raised while an instance is being created, pointing at the cipher rather than at
the empty value that caused it.

`<` is the correct guard: anything shorter cannot be one of ours, and a blob of
exactly that length that was not sealed here still fails the GCM tag.

**Applies to.** `server/src/secrets/cipher.ts`, `server/test/cipher.test.ts`,
issue #32.
