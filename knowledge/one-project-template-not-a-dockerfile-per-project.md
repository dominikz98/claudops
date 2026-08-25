# One template Dockerfile with `if`, not a generated Dockerfile per project

**Fact.** `docker/project/Dockerfile` is a single static file for every project.
The building blocks arrive as build args and each is one `RUN` guarded by
`if [ "${WITH_DOTNET}" = "1" ]`. The server passes every arg on every build,
including the ones that are off (`WITH_PLAYWRIGHT=0`), and never generates a
Dockerfile.

**Why.** The alternative -- writing a Dockerfile per project containing only the
chosen blocks -- was rejected for three reasons:

- **Cache sharing.** Docker keys a layer on the instruction plus the values of
  the args it references. Identical blocks therefore produce identical
  instructions, so two projects with the same environment share their layers and
  an unchanged rebuild is seconds. Generated files would do this too, but only as
  long as the generator emits byte-identical text, which is a promise nobody
  keeps for long.
- **It can be built by hand.** `docker build --build-arg WITH_DOTNET=1
  docker/project` is the whole reproduction of what the server does, which is
  what `docker/project/smoke-test.sh` uses.
- **Nothing to review twice.** A generator makes the real Dockerfile invisible in
  the repository, and a template that lives in a string is a template nobody
  reads.

**Two constraints this shape imposes:**

- **No `COPY` in the template.** With one, the build context contents would enter
  the cache key and an unrelated file changing would invalidate the layers.
  Without one, the context is just the Dockerfile.
- **`ENV` cannot be conditional.** A Dockerfile has no `if` at the instruction
  level, only inside a `RUN`. `DOTNET_ROOT` and `PLAYWRIGHT_BROWSERS_PATH` are
  therefore set unconditionally, which is harmless, and documented as such in the
  file.

`docker/project-stub/Dockerfile` is the same shape with no installs, for the
tests that drive the server rather than the image -- point one at it with
`CLAUDOPS_PROJECT_CONTEXT`.

**Applies to.** `docker/project/`, `server/src/projects/images.ts`, issue #7.
