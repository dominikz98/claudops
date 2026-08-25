# The database holds identity, Docker holds state

**Fact.** The `instances` table has no `status` column. `GET /instances` reads
the rows and joins them against `docker ps -a --filter label=claudops.instance`,
taking the state from there. A row whose container is not in that list reports
`missing`. `POST` writes the row first and only then creates the container,
rolling the row back if Docker fails.

**Why.** A status column starts lying the moment somebody runs `docker stop` on
the NUC, and nothing in the server would notice -- the alternative would be a
poller keeping a copy of state Docker already owns. The write order is the other
half of the same argument: a container created before its row exists is
unfindable, because the only handle on it is the label the row would have
carried, while a row without a container is visible as `missing` and can be
cleaned up. That asymmetry is why the rollback sits on the row and not on the
container.

**How the reconcile stays inside that rule.** "Mark an instance whose container
is gone as ended" is not a status write: the startup pass sets `container_id` to
NULL, which is the row admitting it has no container, and `missing` follows from
the join as it always did. The row itself survives -- it is somebody's instance,
and only Docker's half of it went away. Nulling the column also frees the unique
index, so a container id Docker reuses later can be attached to the next
instance. `stop` and `start` write nothing at all: they ask Docker and then
report what Docker says.

**Applies to.** `server/src/db/migrations.ts`, `server/src/db/instances.ts`,
`server/src/instances/service.ts`, issues #3, #8.
