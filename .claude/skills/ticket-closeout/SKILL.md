---
name: ticket-closeout
description: Use when an implementation is finished and about to become a pull request - "I am done", "let's open the PR", "close out the ticket". Walks the gates and the rule 2-4 checklist from CLAUDE.md. Do not open a PR for a claudops ticket without it.
---

# Ticket close-out

Working code is not a finished ticket. Walk this list in order and create a todo
per item. Nothing here may be reported from memory -- run it, read the output.

## 1. Gates (rule 2)

Run every gate that applies to what you touched:

1. `docker build` of each touched image
2. the smoke test of each touched component, e.g.
   ```bash
   ./docker/base/smoke-test.sh
   ```
3. once a server exists: `pnpm lint`, `pnpm tsc --noEmit`, `pnpm test`
4. `git status` -- clean apart from the intended change

A red gate stops the close-out. Fix the cause; never rerun with the check
weakened. A gate that genuinely does not apply is named as not applicable, with
the reason.

## 2. Knowledge base (rule 3)

Skill: `domain-knowledge`. What did you learn that the next person would spend an
hour rediscovering? Write it to `knowledge/`, index it. "Nothing new" is a valid
answer that has to be said out loud.

## 3. Wiki (rule 4)

Skill: `project-wiki`. Did anything change that a user or colleague sees -- an
endpoint, an environment variable, a default, a procedure? Update `wiki/` in this
same PR. "Nothing user-visible" is a valid answer that has to be said out loud.

## 4. Pull request

Branch `feature/dz/<ticket>` or `bugfix/dz/<ticket>`. Body:

```markdown
## Summary

Two or three sentences: what changed and why.

## Gates

- [x] `docker build docker/base` - ok
- [x] `./docker/base/smoke-test.sh` - 24 passed, 0 failed
- [ ] `pnpm test` - n/a, no server code yet
- [x] `git status` - clean

## Knowledge / wiki

- knowledge/: <entry> (or: nothing new)
- wiki/: <page> (or: nothing user-visible)

Closes #<n>
```

Then verify the PR against the issue's acceptance criteria, one by one. An
unfulfilled criterion is either done or stated in the PR as open, with the
reason.

## Red flags

| Thought | Reality |
| --- | --- |
| "The tests passed earlier" | Run them again. Earlier was a different tree. |
| "The smoke test is slow, I will skip it" | The gate exists for the run you want to skip. |
| "I will document it after the merge" | It never happens. Same PR or not at all. |
| "Nothing worth writing down" | Say it explicitly, then it is a decision, not an omission. |
