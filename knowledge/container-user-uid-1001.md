# The container user is UID 1001, not 1000

**Fact.** `claudops-base` creates the non-root user `claude` with UID/GID 1001.

**Why.** The image builds `FROM node:22-bookworm`, which already ships a `node`
user at UID 1000. Using 1000 fails the `useradd` at build time. 1001 is exposed as
the `USER_UID`/`USER_GID` build args, so a project image can shift it if a mounted
volume demands a specific owner.

**Applies to.** `docker/base/Dockerfile`, `docker/base/smoke-test.sh` (asserts
`id -u` is 1001), issue #7.
