# The image status is the one piece of state the database is allowed to hold

**Fact.** `projects.image_status`, `image_log` and `image_built_at` (migration 3)
record how a project's image build went. That is a deliberate exception to
[database-holds-identity-docker-holds-state.md](database-holds-identity-docker-holds-state.md).

**Why.** A container that exists can be asked about itself, so the instance table
needs no status column. A build that *failed* leaves nothing behind to ask: no
image, no container, no Docker object of any kind. Its status and its output exist
only where the server wrote them down. Recording nothing would mean a project
whose environment cannot be built looks exactly like one nobody has built yet,
and instance creation would keep answering "not ready" without ever saying why.

**Where the line still holds.** Whether the image *exists* remains Docker's
answer: an instance start on a project that claims `ready` but whose tag somebody
removed by hand fails with `ImageNotFoundError`, not with a lie from the database.
The column says what the last build did, not what the daemon has.

**Consequences worth knowing:**

- A build result must not touch `updated_at` -- it is the server talking to
  itself, not an edit of the project. Hence `setImageState` next to `update`.
- `building` is never valid across a restart: no build survives the process that
  ran it, so `resumePending()` treats it as a leftover and requeues it.
- `failed` is never cleared automatically. Retrying a broken Dockerfile on every
  start would be a loop; `POST /projects/:id/build` is the way out.

**Applies to.** `server/src/db/migrations.ts`, `server/src/projects/images.ts`,
issue #7.
