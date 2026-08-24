---
name: project-wiki
description: Use when a change affects what a user or colleague sees or does - a new endpoint, an environment variable, an operating procedure, a changed default - or when documenting how to run and operate claudops. Reads and writes wiki/. Mandatory at ticket close-out (CLAUDE.md rule 4).
---

# Project wiki

`wiki/` is the documentation for humans who operate claudops without reading the
source: users and colleagues. Its counterpart is `knowledge/` (skill:
`domain-knowledge`), which is for Claude and records *why*.

## Audience test

Write for a colleague who has NUC access, knows Docker, and has never seen this
repository. If a sentence only makes sense with the source open next to it, it
belongs in `knowledge/` or in a code comment instead.

## Pages

| Page | Holds |
| --- | --- |
| `README.md` | Index and current state. Every page is linked here. |
| `architecture.md` | Components, data flow, the decisions a reader must know. |
| `getting-started.md` | From zero to a running instance, copy-pasteable. |
| `operations.md` | Running it: limits, cleanup, troubleshooting, logs. |
| `glossary.md` | Project terms: instance, project, project image, bridge. |

Add a page only for a topic that does not fit an existing one, and link it in
`README.md` in the same commit.

## Rules

- Every command shown must have been run. No invented flags, no untested
  copy-paste.
- Document what exists today. Planned behaviour is marked `Planned (#<n>)` or
  left out.
- Environment variables and endpoints live in tables, not prose.
- Keep it in sync in the same PR as the change. A wiki that lags is worse than a
  missing one, because it is trusted.
- German is not permitted in the wiki -- see CLAUDE.md, "Language".
