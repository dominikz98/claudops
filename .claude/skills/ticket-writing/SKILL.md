---
name: ticket-writing
description: Use when creating or rewriting a GitHub issue for claudops, splitting work into tickets, or when an issue body has grown into prose. Enforces the short-ticket format from CLAUDE.md rule 1.
---

# Ticket writing

An issue answers two questions: **what** is to be built and **when is it done**.
Everything else belongs in the EPIC, the wiki, or `knowledge/`.

## Format

```markdown
One-line summary of the work, no ticket prefix.   <- title

## Scope

- bullet per deliverable, noun phrase, no prose
- a decision only where it constrains the work

## Acceptance criteria

- [ ] observable, checkable from the outside
- [ ] one criterion per line
```

Budget: ~15 lines of body, hard stop at 25. Over budget means it is two tickets.

## Acceptance criteria

Checkable means: someone else can run it and see pass or fail.

- Good: "`docker inspect` shows the CPU and memory limits"
- Good: "grep over logs and DB finds no tokens"
- Bad: "limits work correctly", "is well tested", "clean code"

## Cut against

- architecture prose -> the EPIC or `wiki/architecture.md`
- reasoning for a decision -> `knowledge/`
- implementation steps, code, file layout -> not in the ticket at all
- repetition of what a linked issue already says -> link it (`see #4`)

## EPICs

An EPIC carries goal, architecture sketch, the handful of core decisions and the
order of the work packages. It is the one place where prose is allowed, and it is
still short. Work packages hang off it as sub-issues.

## Rewriting

When trimming an existing issue, move the removed substance -- do not lose it.
Reasoning goes to `knowledge/`, user-facing description to `wiki/`, everything
else was noise.
