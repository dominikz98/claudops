# The container list carries health only as prose

**Fact.** `GET /containers/json` -- dockerode's `listContainers` -- has no health
field. The state is in the human-readable `Status` string, as `Up 2 minutes
(healthy)` or `Up 12 seconds (health: starting)`. The structured value lives on
`GET /containers/<id>/json`, as `State.Health.Status`, so
`DockerodeEngine.listManagedContainers` inspects every *running* container it
listed and never parses that string.

**Why.** `Status` is documented as human-readable and is formatted for
`docker ps`, not for a parser: it is the one field in that response that may be
reworded without it counting as an API change. An extra inspect per running
container is the price, paid in parallel and only for containers that are up --
a stopped one has no session to be ready. On a NUC with a handful of instances
that is a few calls against a local socket per list.

**Applies to.** `server/src/docker/dockerode-engine.ts`,
`server/src/docker/engine.ts` (`ContainerHealth`), issue #25.
