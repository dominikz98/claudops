# A memory limit without a swap limit is a memory limit of twice that

**Fact.** Instance containers are created with `Memory` *and* `MemorySwap` set to
the same value. `MemorySwap` is not a separate swap budget -- it is the total of
memory plus swap.

**Why.** Left unset, Docker gives a container with a memory limit twice that
limit in swap. A 4 GB instance would then be allowed 8 GB before anything stops
it, and it would spend the difference paging -- on a NUC with one disk that means
the server, the other instances and the SSH session all crawl, which is worse
than the container simply being killed. Equal values disable swap for the
container, so an instance that goes over its limit is OOM-killed and shows up as
`exited` with code 137 rather than taking the box down with it.

The other half of the same call is `NanoCpus`, which is what the API calls
`--cpus`: 1e9 per core, a ceiling on CPU time rather than a pinning to particular
cores.

**Applies to.** `server/src/docker/dockerode-engine.ts`, `server/src/config.ts`,
issue #8.
