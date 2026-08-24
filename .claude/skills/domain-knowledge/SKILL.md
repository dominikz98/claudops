---
name: domain-knowledge
description: Use when starting work on a claudops ticket, or when you learned something non-obvious about the domain - a decision and its reason, a pitfall, a constraint that cost time to find out. Reads and writes the knowledge base in knowledge/. Mandatory at ticket close-out (CLAUDE.md rule 3).
---

# Domain knowledge database

`knowledge/` is the project's memory of *why*, for Claude. Not a copy of the code
and not user documentation -- that is `wiki/` (skill: `project-wiki`).

## Read first

Before touching a ticket, read [knowledge/README.md](../../../knowledge/README.md)
and open the entries whose one-liner touches your ticket. This costs a minute and
saves the rediscovery of settled decisions.

## What belongs in it

A fact earns a file when it is **non-obvious and expensive to rediscover**:

- a decision plus the alternative it beat, and why (`tmux new -A` over an
  application-level scrollback buffer)
- a pitfall with its symptom (`docker exec` without `-t` and no `TERM` fails with
  "terminal does not support clear")
- a constraint from outside the repo (an `ANTHROPIC_API_KEY` overrides the
  subscription token)
- a deliberate non-goal (no devcontainer features -- no layer caching)

What does **not** belong: anything a reader gets from the code in under a minute,
step-by-step instructions (wiki), ticket status (GitHub).

## Write

One fact per file, `knowledge/<kebab-case-topic>.md`:

```markdown
# <Title as a claim, not a topic>

**Fact.** One or two sentences, stated as a conclusion.

**Why.** The reasoning, the alternative that lost, the symptom it prevents.

**Applies to.** Files, components or issues the fact governs.
```

Then add the one-liner to `knowledge/README.md` -- an entry that is not in the
index does not exist. Keep it to `- [Title](file.md) - hook`.

## Maintain

- A fact that turns out wrong gets corrected or deleted, not appended to.
- Two files on the same fact: merge, keep the better title.
- A fact that has become obvious (the code now says it plainly) gets deleted.
