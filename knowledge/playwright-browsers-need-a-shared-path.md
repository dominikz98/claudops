# Playwright's browsers have to be installed to a shared path, not to a home

**Fact.** In the project image the Playwright block installs as `root` and the
container then runs as `claude` (UID 1001,
[container-user-uid-1001.md](container-user-uid-1001.md)). Without
`PLAYWRIGHT_BROWSERS_PATH` the browsers land in the installing user's home --
`/root/.cache/ms-playwright` -- where `claude` cannot read them, and every
`chromium.launch()` fails with "Executable doesn't exist". `docker/project/Dockerfile`
therefore sets `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` before installing and
follows the install with `chmod -R a+rX`.

**Two more things that bite in the same place:**

- **Chromium needs `--no-sandbox` in a claudops container.** Its own sandbox
  wants privileges the container deliberately does not have. Playwright's own
  images solve this with a seccomp profile; here the launch argument is the
  cheaper answer, and it is what `docker/project/smoke-test.sh` uses.
- **`NODE_PATH=/usr/local/lib/node_modules` is set on purpose.** The block
  installs `playwright` globally, and without `NODE_PATH` a repository that does
  not depend on Playwright itself cannot `require` it. A local `node_modules`
  still wins, so a repository pinning its own version keeps it -- and then has to
  install its own browsers, because the prebuilt ones belong to the global
  version.

Unrelated to the *host* side of the same trap, where pnpm blocks the postinstall
that fetches a browser at all
([playwright-browsers-need-an-explicit-install.md](playwright-browsers-need-an-explicit-install.md)).

**Applies to.** `docker/project/Dockerfile`, issue #7.
