# Foreign keys are off unless openDatabase opened the file

**Fact.** `PRAGMA foreign_keys = ON` is set in `server/src/db/index.ts`, in
`openDatabase` -- not in `migrate`. A test that builds its database with
`new Database(':memory:')` plus `migrate(db)`, which most of them do, runs with
foreign keys *off*: deleting a project an instance points at succeeds there and
fails in production.

**Why.** SQLite defaults to foreign keys disabled and the pragma is per
connection, not per file, so it cannot live in the schema. The failure mode is
the bad kind: a test asserting "the delete is refused" passes for the wrong
reason if it asserts against the service, and silently proves nothing if it
asserts against the constraint. Hence two things in the code: the service counts
the instances itself and throws `ProjectInUseError` (which also gives the answer
a number), and the one test about the constraint uses `openDatabase(':memory:')`
on purpose.

**Applies to.** `server/src/db/index.ts`, `server/test/db.test.ts`,
`server/src/projects/service.ts`.
