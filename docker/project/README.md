# Project images

The environment a project's instances run in: `claudops-base` plus the building
blocks the project has ticked. One template for every project, steered by build
args -- identical blocks produce identical instructions, so two projects with the
same environment share their layers and an unchanged rebuild comes off the cache
in seconds.

The claudops server builds this through the Docker API on project create and
whenever the building blocks change, and tags the result
`claudops-project-<project id>`. Instances start from that image; there is no
fallback to installing anything at container start, which is why a failed build
blocks instance creation. See [wiki/architecture.md](../../wiki/architecture.md).

## Build

The same thing the server does, by hand:

```bash
docker build -t claudops-project-demo \
  --build-arg WITH_DOTNET=1 \
  --build-arg WITH_PLAYWRIGHT=1 \
  docker/project
```

## Build args

| Arg | Default | Purpose |
| --- | --- | --- |
| `BASE_IMAGE` | `claudops-base` | What the template builds on. The server passes `CLAUDOPS_BASE_IMAGE`. |
| `WITH_DOTNET` | `0` | `1` installs the .NET SDK into `/usr/share/dotnet`. |
| `WITH_PLAYWRIGHT` | `0` | `1` installs Playwright and Chromium with their system dependencies. |
| `DOTNET_CHANNEL` | `10.0` | Channel for `dotnet-install.sh`: a version, `LTS` or `STA`. The server passes `CLAUDOPS_DOTNET_CHANNEL`. |
| `USER_NAME` | `claude` | The user the image goes back to. Matches `docker/base`. |

Every arg is passed on every build, including the blocks that are off -- the
template compares against `"1"`, so a missing arg would silently take the default
instead.

## What the blocks add

**dotnet.** `dotnet-install.sh` into `/usr/share/dotnet`, plus `libicu72`, which
.NET needs on bookworm. `DOTNET_ROOT` and `PATH` are set, `dotnet` is on the path,
and telemetry is off.

**Playwright + Chromium.** `playwright` installed globally and
`playwright install --with-deps chromium`. Two details that matter inside a
claudops container:

- The browsers live in `/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`) rather than
  in a home directory: they are installed by root and used by `claude`.
- Chromium needs `--no-sandbox` here, because its own sandbox wants privileges
  the container does not have:

  ```js
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  ```

`NODE_PATH=/usr/local/lib/node_modules` makes the global `playwright` requirable
from a repository that does not depend on it. A repository with its own
`node_modules` keeps its own version -- and then needs its own
`playwright install`, because the prebuilt browsers belong to the global one.

Both are in [knowledge/playwright-browsers-need-a-shared-path.md](../../knowledge/playwright-browsers-need-a-shared-path.md).

## Inherited from claudops-base

Entrypoint, tmux configuration, the git credential helper, the `claude` user and
every environment variable in [`../base/README.md`](../base/README.md). The
template installs as root and hands the image back to `claude` at the end, so an
instance of a project image behaves exactly like one of the base image -- it just
has more tools.

## Test

```bash
./docker/project/smoke-test.sh
```

Builds the template with both blocks, checks `dotnet --version` and a real
Chromium launch inside a container, and measures a second build to show the layer
cache did its job. Slow on the first run -- a dotnet SDK and a Chromium are a few
hundred megabytes. `SKIP_BASE=1` reuses an existing `claudops-base:test`.

## `../project-stub`

The same shape with no installs. The tests that drive the *server* -- the smoke
test and the browser tests -- point a server at it with
`CLAUDOPS_PROJECT_CONTEXT`, so they can check that building blocks turn into a
build, a status and a gate without waiting minutes for a toolchain nobody
inspects there. It writes the args it was built with to
`/tmp/claudops-blocks`, which is what those tests assert on.
