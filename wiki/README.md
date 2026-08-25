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

A project holds a repository, a branch, its credential and an environment that the
server prebuilds as its own image; an instance is created from it, driven, stopped
and deleted from a browser page, its console survives a refresh, it runs under a
CPU and memory ceiling, and what a restart or a hand on the NUC leaves behind is
cleaned up at the next server start. Everything else
is planned and marked with its issue number on the pages below. The component status table lives in the
[root README](../README.md#state) -- kept in one place so the two cannot drift
apart.

The internal notes on *why* things are the way they are live in
[knowledge/](../knowledge/README.md) and are aimed at Claude, not at users.
