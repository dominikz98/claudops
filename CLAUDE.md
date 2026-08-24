# CLAUDE.md

Project rules for Claude Code in this repository. The global `~/.claude/CLAUDE.md`
and `PRINCIPLES.md` still apply; what follows is additional and takes precedence
on conflict.

## Project

claudops runs isolated Claude Code instances in Docker containers on an Intel NUC
(Ubuntu). A small web UI mirrors their consoles, manages projects (repo +
environment) and recycles containers on delete. See [wiki/architecture.md](wiki/architecture.md).

Stack: Node LTS + TypeScript, pnpm, Fastify, dockerode, SQLite (better-sqlite3),
Vite SPA with `@xterm/xterm`.

Conventions: shell `pwsh`, package manager `pnpm`, branches `feature/dz/<ticket>`
or `bugfix/dz/<ticket>`.

## Language

Everything in this repository is **English**: code, comments, log output, commit
messages, issues, pull requests, wiki, knowledge base. Conversation with the user
may be German -- artefacts never are.

## Rules

### 1. Keep tickets short

An issue states *what* and *when it is done*, not *how*.

- Title: one line, imperative, no ticket prefix.
- Body: a `## Scope` bullet list plus `## Acceptance criteria` as checkboxes.
- Budget: ~15 lines, hard stop at 25. If it needs more, it is two tickets.
- No architecture prose, no code, no repetition of what the EPIC or the wiki
  already says -- link instead.
- Record a decision only where it constrains the work ("dockerode exec with TTY,
  no attach API"), not as an essay.

Skill: `ticket-writing`.

### 2. Done means: tests green, then a PR with gates

No pull request before the full test suite has actually run locally and passed.
"Should pass" is not a result -- paste the output.

Gates, all of them, in this order:

1. `docker build` of every touched image
2. every smoke test of a touched component (e.g. `./docker/base/smoke-test.sh`)
3. once a server exists: `pnpm lint`, `pnpm tsc --noEmit`, `pnpm test`
4. `git status` clean apart from the intended change

The PR body carries a `## Gates` section listing each gate with its result, plus
`Closes #<n>`. A red or skipped gate is named as such -- never silently dropped.

Skill: `ticket-closeout`.

### 3. Maintain the domain knowledge database

`knowledge/` holds the non-obvious facts about this domain, for Claude: decisions
and their reasons, pitfalls, constraints that cost time to find out. One fact per
file, indexed in [knowledge/README.md](knowledge/README.md). Not documentation of
what the code plainly says.

Read the index before starting work on a ticket; write to it whenever you learn
something that would have saved you time.

Skill: `domain-knowledge`.

### 4. Keep a wiki in Markdown

`wiki/` is the documentation for humans -- users and colleagues -- who want to
operate claudops without reading the source: architecture, getting started,
operations, glossary. Indexed in [wiki/README.md](wiki/README.md).

Every user-visible change updates the wiki in the same PR.

Skill: `project-wiki`.

### 5. Ticket close-out covers rules 2 to 4

A ticket is not finished when the code works. Before the PR:

- [ ] Rule 2: all gates run, output pasted, PR opened with `## Gates`
- [ ] Rule 3: `knowledge/` updated with what was non-obvious (or explicitly: nothing new)
- [ ] Rule 4: `wiki/` updated for every user-visible change (or explicitly: nothing user-visible)

The two "explicitly nothing" cases are legitimate answers -- an unmentioned one
is not.

Skill: `ticket-closeout` walks the checklist.
