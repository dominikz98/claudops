# `putArchive` gives the file the uid from the tar header, not the container's user

**Fact.** The extraction behind `PUT /containers/<id>/archive` runs as root in
the daemon and applies the ownership the archive asks for. A header with `uid 0`
produces a `root:root` file inside the container even though that container runs
as `claude`, and a header with `uid 1001` produces a `claude:claude` one.
`server/src/docker/tar.ts` therefore writes 1001/1001 by default
(`CONTAINER_UID`, `CONTAINER_GID`) rather than leaving the field at zero.

**Why.** Measured, not assumed: two archives with the same content into the same
running `claudops-base` container, one with uid 0 and one with uid 1001.

```
-rw-r--r-- 1    0    0 5 owned-by-0.txt
-rw-r--r-- 1 1001 1001 5 owned-by-1001.txt
```

A zero in that field is easy to write and hard to notice. The agent can still
*read* a 0644 root-owned file, so an attachment would appear to work -- Claude
describes the screenshot, the acceptance criterion passes. What fails is
everything afterwards: the agent cannot move the file, cannot overwrite it with a
corrected version and cannot delete it to free the instance's upload budget, and
the reason ("permission denied on a file I was just handed") is far from the tar
header that caused it.

1001 rather than 1000 for the usual reason -- the node image already took 1000
(see [The container user is UID 1001](container-user-uid-1001.md)). A project
image that ever changed its user would have to change these two constants with
it; nothing reads the uid out of the image today.

**Applies to.** `server/src/docker/tar.ts`, `server/src/instances/service.ts`
(`upload`), issue #15. The smoke test asserts it against a real daemon: "It
belongs to the agent, not to root" in `server/smoke-test.sh`.
