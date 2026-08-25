# claudops

Run isolated Claude Code instances in Docker containers on an Intel NUC, and
drive their consoles from the browser. Each instance clones a repository, starts
Claude Code inside a tmux session, and survives a browser refresh -- the session
lives in the container, not in the browser tab.

## State

Projects hold a repository, a branch, its credential and an environment that is
prebuilt as an image; instances are created from them, driven and deleted from a
browser page on the server's own port, and a console survives a refresh.
Everything else is planned; see the
[issues](https://github.com/dominikz98/claudops/issues) and
[EPIC #1](https://github.com/dominikz98/claudops/issues/1).

| Component | State |
| --- | --- |
| Base image `claudops-base` | Available, smoke-tested |
| Server (Fastify, dockerode, SQLite) | Available, smoke-tested |
| Terminal bridge (WebSocket) | Available, smoke-tested |
| Web UI (xterm.js) | Available, end-to-end tested |
| Projects (repo, branch, PAT) | Available, end-to-end tested |
| Project images from building blocks | Available, smoke-tested |
| Lifecycle, limits, recycling | Planned (#8) |
| Auth, egress firewall, UI login | Planned (#9) |

## Quick start

```bash
docker build -t claudops-base docker/base
pnpm install && pnpm build
```

```bash
CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
CLAUDOPS_SECRET_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')" \
node server/dist/index.js
```

Then <http://localhost:8080>: create a project on the **Projects** page and wait
for its image to say `ready` -- that is the environment its instances run in --
then name an instance, pick the project, press Create, press Console. The same
thing over the API, which is what the page uses and nothing else needs:

```bash
curl -s localhost:8080/projects \
  -H 'content-type: application/json' \
  -d '{"name":"claudops","repoUrl":"https://github.com/dominikz98/claudops.git"}'
```

```bash
curl -s localhost:8080/instances \
  -H 'content-type: application/json' \
  -d '{"name":"demo","projectId":"<project id>"}'
```

The answer carries the instance `id`, and its console is one WebSocket away:

```bash
npx wscat -c 'ws://localhost:8080/instances/<id>/terminal?cols=120&rows=40'
```

Detach with `Ctrl-b d`; Claude keeps running, and reconnecting -- or simply
reloading the page -- finds the session and its scrollback untouched, because both
live in the container. The full walkthrough is in
[wiki/getting-started.md](wiki/getting-started.md), the API and the server's
configuration in [server/README.md](server/README.md).

## Layout

| Path | Contains |
| --- | --- |
| [`docker/base/`](docker/base/) | The `claudops-base` image, its entrypoint and its smoke test |
| [`server/`](server/README.md) | The Fastify server: instance REST, terminal bridge, Docker access, SQLite, its smoke tests |
| [`web/`](web/README.md) | The Vite SPA: instance list and the xterm.js console, served by the server |
| [`e2e/`](e2e/run.sh) | Playwright: the browser acceptance tests, against a real server and real containers |
| [`wiki/`](wiki/README.md) | Documentation for users and colleagues: architecture, getting started, operations, glossary |
| [`knowledge/`](knowledge/README.md) | Domain knowledge database: the non-obvious decisions and their reasons |
| [`CLAUDE.md`](CLAUDE.md) | Project rules for Claude Code working in this repository |
| [`.claude/skills/`](.claude/skills/) | Skills that make those rules executable |

## Contributing

Read [CLAUDE.md](CLAUDE.md) first -- it defines how tickets are written, what
"done" means, and what a ticket close-out has to cover. In short: keep tickets
short, run every gate before opening a PR, and keep `knowledge/` and `wiki/` in
step with the change.

Branches are `feature/dz/<ticket>` or `bugfix/dz/<ticket>`. Everything in this
repository is written in English.

## Test

```bash
pnpm lint && pnpm tsc --noEmit && pnpm test
```

```bash
./docker/base/smoke-test.sh
./server/smoke-test.sh
./server/terminal-smoke-test.sh
./e2e/run.sh
```

The unit tests need no Docker; the smoke tests and the browser tests do, and
`./e2e/run.sh` also needs Chromium once per machine
(`pnpm --filter @claudops/e2e exec playwright install chromium`). `SKIP_BUILD=1`
makes one of them reuse what is already built -- which also means it tests the
previous build, so leave it off after a code change.
