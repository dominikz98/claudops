# `docker rm -v` is only half of a delete

**Fact.** `InstanceService.delete` removes the container with `v: true` *and*
then removes every volume that carries `claudops.instance=<id>`. The startup
reconcile does the same for volumes whose instance no longer exists. Today
nothing in claudops creates a volume at all -- `claudops-base` declares no
`VOLUME` and `runContainer` mounts none -- so both sweeps normally find nothing.

**Why.** `-v` takes a container's *anonymous* volumes, and only while that
container is still there. It does not touch a named volume, and it never runs at
all for an instance whose container somebody already removed by hand -- which is
exactly the case that leaves a workspace behind on the NUC with nothing left to
name it by. The label is the second handle, and the sweep that uses it is what
makes "after a delete nothing of that instance remains" true regardless of which
half went missing first.

That the sweep currently has nothing to find is not a reason to drop it: the
moment a project image declares a `VOLUME`, or somebody starts a container by
hand with the claudops label, it is the only thing that cleans up after them.

**Applies to.** `server/src/instances/service.ts`,
`server/src/docker/dockerode-engine.ts`, issue #8.
