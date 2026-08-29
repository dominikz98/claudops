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

A project holds a repository, a branch, its credential, the variables and egress
hosts its instances run with, and an environment that the
server prebuilds as its own image; an instance is created from it, driven, stopped
and deleted from a browser page, its console survives a refresh, it runs under a
CPU and memory ceiling, and what a restart or a hand on the NUC leaves behind is
cleaned up at the next server start. Both slow steps report progress: an image
build's log grows on the Projects page while it runs, and an instance says whether
its Claude session is up, not only whether its container is. Each instance runs
the model and effort level it was given, changeable from the list without losing
the session, and files and pasted screenshots go into a running instance from its
console and land next to the clone rather than in it. The list also says what
Claude is doing in each instance -- working, waiting for an answer, or finished --
reported by the instance itself, with a browser notification for the one that is
waiting. What a run produced is readable from the console page: a file tree of
the workspace next to the terminal, with Markdown rendered, images shown and
everything else downloadable, without any of it having been committed. A project
also carries what its instances need beyond the repository: named variables,
sealed like the PAT and never shown again, and the hosts its instances may reach
on top of the server-wide whitelist -- which together are what lets a repository's
own `.mcp.json` start with a credential it does not hold.
Everything else is planned
and marked with its issue number on the pages below. The component status table lives in the
[root README](../README.md#state) -- kept in one place so the two cannot drift
apart.

The internal notes on *why* things are the way they are live in
[knowledge/](../knowledge/README.md) and are aimed at Claude, not at users.
