# claudops wiki

Documentation for people who run claudops: how it is put together, how to get an
instance going, how to operate it. Written for a colleague with NUC access who
knows Docker and has never seen this repository.

## Pages

- [Architecture](architecture.md) - components, data flow, the decisions worth knowing
- [Getting started](getting-started.md) - from zero to a running instance
- [Operations](operations.md) - running it, cleaning up, troubleshooting
- [Glossary](glossary.md) - what instance, project and bridge mean here

The REST API and the server's own configuration are documented next to the code,
in [server/README.md](../server/README.md).

## Current state

An instance can be started, listed and removed over REST. The console still goes
through `docker exec`; everything else is planned and marked with its issue
number on the pages below.

| Component | State |
| --- | --- |
| Base image `claudops-base` | Available, smoke-tested |
| Server (REST, Docker, SQLite) | Available, smoke-tested |
| Terminal bridge (WebSocket) | Planned (#4) |
| Web UI | Planned (#5) |
| Projects and project images | Planned (#6, #7) |
| Lifecycle, limits, recycling | Planned (#8) |
| Auth, egress firewall, UI login | Planned (#9) |

The internal notes on *why* things are the way they are live in
[knowledge/](../knowledge/README.md) and are aimed at Claude, not at users.
