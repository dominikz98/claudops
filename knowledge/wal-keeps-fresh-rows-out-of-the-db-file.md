# In WAL mode a fresh row is in the -wal file, not in the .db

**Fact.** The database runs with `journal_mode = WAL`, so a row written seconds
ago sits in `claudops.db-wal` and reaches `claudops.db` only at a checkpoint. Any
check that reads the database as bytes has to read both files:
`cat "$DB_FILE" "$DB_FILE-wal"`.

**Why.** Found by writing an assertion that should have failed and did not: the
smoke test greps the database file for the PAT probe, and that grep answered
"absent" for a token which -- at that point in the test -- was simply not in the
`.db` yet. The check therefore proved nothing, and would have kept passing if the
server had stored the token in the clear. A grep that cannot fail is worse than
no grep, because it reads as evidence in a close-out.

**Applies to.** `server/src/db/index.ts` (the pragma),
`server/smoke-test.sh` (`db_bytes`). Related:
[Verify line endings with cat-file and byte counting, not with grep](verifying-line-endings.md).
