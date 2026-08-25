# claudops

Run isolated Claude Code instances in Docker containers on an Intel NUC, and
drive their consoles from the browser. Each instance clones a repository, starts
Claude Code inside a tmux session, and survives a browser refresh -- the session
lives in the container, not in the browser tab.

## State

Instances can be started, listed and removed over REST, and their consoles are
mirrored over a WebSocket. Everything else is planned; see the
[issues](https://github.com/dominikz98/claudops/issues) and
[EPIC #1](https://github.com/dominikz98/claudops/issues/1).

| Component | State |
| --- | --- |
| Base image `claudops-base` | Available, smoke-tested |
| Server (Fastify, dockerode, SQLite) | Available, smoke-tested |
| Terminal bridge (WebSocket) | Available, smoke-tested |
| Web UI (xterm.js) | Planned (#5) |
| Projects and project images | Planned (#6, #7) |
| Lifecycle, limits, recycling | Planned (#8) |
| Auth, egress firewall, UI login | Planned (#9) |

## Quick start

```bash
docker build -t claudops-base docker/base
pnpm install && pnpm build
```

```bash
CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" node server/dist/index.js
```

```bash
curl -s localhost:8080/instances \
  -H 'content-type: application/json' \
  -d '{"name":"demo","repoUrl":"https://github.com/dominikz98/claudops.git"}'
```

The answer carries the instance `id`; its console is one WebSocket away:

```bash
npx wscat -c 'ws://localhost:8080/instances/<id>/terminal?cols=120&rows=40'
```

Detach with `Ctrl-b d`; Claude keeps running, and reconnecting finds the session
and its scrollback untouched -- both live in the container. The full walkthrough is in
[wiki/getting-started.md](wiki/getting-started.md), the API and the server's
configuration in [server/README.md](server/README.md).

## Layout

| Path | Contains |
| --- | --- |
| [`docker/base/`](docker/base/) | The `claudops-base` image, its entrypoint and its smoke test |
| [`server/`](server/README.md) | The Fastify server: instance REST, terminal bridge, Docker access, SQLite, its smoke tests |
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
```

The unit tests need no Docker; the smoke tests do. `SKIP_BUILD=1` makes one of
them reuse what is already built -- which also means it tests the previous build,
so leave it off after a code change.
