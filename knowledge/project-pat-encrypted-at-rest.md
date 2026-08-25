# A project's PAT is encrypted at rest, an instance's is not stored at all

**Fact.** The git token of a project lives in `projects.git_token` as an
AES-256-GCM blob, prefixed `v1:` and produced by `src/secrets/cipher.ts`. The key
comes from `CLAUDOPS_SECRET_KEY` (32 bytes, base64 or hex) and never reaches the
database. Without the key the server still runs: a project without a PAT works, a
request that carries one answers `422 secret_key_missing`. Instances keep nothing
-- the decrypted token is handed to the container as `GIT_TOKEN` and forgotten.

**Why.** A template outlives every instance made from it, so its credential has
to survive a restart -- which is exactly what the older rule "no token in the
database" forbade. Encryption is what keeps both: the file on disk holds no
readable secret, so a copied database, a backup or a `grep` over `data/` yields
nothing, and the smoke test's "the PAT is not readable on disk" check stays a
real assertion instead of being weakened. Storing it in the clear with file
permissions was the alternative; it fails the moment the file is copied
somewhere else, which is what backups do for a living. `config.ts` therefore
carries a `SecretCipher` and not the key: `JSON.stringify` of a `Buffer` prints
every byte, and a config object ends up in a log line eventually.

A lost or rotated key costs one thing and nothing else: every project needs its
PAT entered again. Nothing else in the database is encrypted, so a wrong key
surfaces as `422 secret_undecryptable` on instance create -- never as a container
that starts and then cannot clone.

**Applies to.** `server/src/secrets/cipher.ts`, `server/src/config.ts`,
`server/src/projects/service.ts`, `server/smoke-test.sh`, issues #6, #9.
Related: [The Claude auth token is an OAuth token, never an API key](auth-token-handling.md),
[Git tokens reach the container through a credential helper](git-token-via-credential-helper.md).
