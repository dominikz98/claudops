# Prompt: build claudops for the project manager

Paste this into a Claude Code session at the root of this repository. It is the
brief for the next phase, not a specification -- the specification is what you
write out of it, as issues, in the format `CLAUDE.md` rule 1 demands.

---

## Your role

You are the engineer on claudops. Read `CLAUDE.md` first; its five rules bind
every step below, and the skills `ticket-writing`, `domain-knowledge`,
`project-wiki` and `ticket-closeout` are how they are executed. Everything you
write into this repository is English.

Before you propose anything: read `wiki/architecture.md`, the index of
`knowledge/`, `server/README.md`, and issues #1 and #19. Both EPICs are closed.
What exists is a working operator's tool. What follows is the next EPIC.

## The shift

claudops today is built for an **operator**: it starts containers, caps them,
cleans them up, and mirrors a terminal into a browser. Every unit of work still
goes through a human hand on a keyboard, one console at a time.

The next phase is built for a **project manager**. The instances are not
containers any more, they are **staff**: each one is hired for a project, given a
role, handed a briefing, watched while it works, asked when it is stuck, and
collected from when it is done. Twenty of them are a team, and a team is managed
from one page -- not from twenty terminals.

The console does not disappear. It becomes what looking over a colleague's
shoulder is: available, occasionally necessary, never the interface.

## The loop to build

```
GitHub issue ──dispatch──▶ assignment ──brief──▶ instance ("employee")
      ▲                         │                      │
      │                         │                 hooks report
      │                         ▼                      ▼
     PR ◀──push──── git state ──── board: working │ needs input │ done
```

Everything in that loop except the two boxes on the right already exists in some
form. The work is closing it.

## Vocabulary

The code keeps its nouns -- `instance`, `project` -- renaming them would churn
the whole repository for nothing. The **UI and the wiki** speak the manager's
language, and `wiki/glossary.md` is where the two are tied together:

| In the code | On the page |
| --- | --- |
| instance | the person doing the work: name, role, what they are on |
| activity `running` / `needs_input` / `done` | working / has a question / finished |
| a prompt typed into tmux | a briefing |
| the workspace and its files | what they produced |
| stop / start | off shift / back on shift |
| delete | let go -- and the desk is cleared with them |

**A project stays a project**, in the code and on the page. It is the one word
the manager's language and the operator's language already agree on, and it is
the thing that carries repository, branch, credential, environment blocks, image,
variables and egress hosts -- the context an instance works *in*. Nothing below
renames it, folds it into anything, or makes it optional.

Do not put cute personifications into log lines, error messages or code
comments. The metaphor shapes *what is built*, not how the machine talks.

## The test the whole EPIC is measured against

A project manager with a browser, **no terminal and no SSH**, can:

1. open claudops, see one board with every instance on it and know, without
   clicking, which of them is working, which is waiting for an answer and which
   is finished;
2. take an open GitHub issue of a project, hand it to a new instance as its
   briefing, and never type into a console;
3. be told -- outside the browser tab -- that somebody is waiting for an answer,
   and answer it from the board;
4. see that the work landed as a branch with commits on it, and push it;
5. send the finished instance off shift so the NUC has room for the next one.

Write that list into the EPIC as its goal. Every work package below is one part
of it, and a package that does not move one of those five points is not in this
EPIC.

## What does not move

These are decisions the repository already paid for. Contradict one only in a
ticket that says so out loud and writes the new reasoning into `knowledge/`:

- **The session lives in the container**, in tmux. Not in the server, not in the
  browser. A restart of the server does not touch a running turn.
- **Docker owns the state, SQLite owns the identity.** No status column. The
  list asks Docker on every request.
- **The activity is in memory** because it is about a process that runs *now*.
  A timeline that persists is a different fact from the current activity and
  must not replace it.
- **The egress firewall is default-deny and cannot be widened from inside.** The
  one hole is the status port with its one route. Anything an instance sends to
  the host goes there, authenticated with that instance's token, or nowhere.
- **`--dangerously-skip-permissions` is only paid for by isolation.** No feature
  gets to soften it.
- **Nothing polls in the server.** The reconcile is a startup pass, deliberately.
  Two packages below need a timer; each has to argue for it rather than assume it.
- **A project is the template, an instance is a copy of it.** Repository,
  branch, environment blocks, variables and egress hosts live on the project and
  nowhere else -- a manager runs several projects at once and they do not share
  an environment. A role, an assignment or a board column is something an
  instance carries *in addition*; none of them may become the place a repository
  or an environment is configured.
- **Secrets are write-only.** A project reports that a PAT is set and the names
  of its variables. Never a value, not in a response, not in a log, not on the
  board.
- **What an agent wrote is never served as a document.** Text or download, never
  `text/html`.

## Anti-goals

- Not a CI system, not a scheduler, not Kubernetes. One NUC, one Docker daemon.
- No multi-tenancy and no user accounts. One shared secret, one manager.
- No parsing of Claude's output to guess what it did. What the instance reports
  through its hooks, what git says, and what is on disk -- those three, nothing
  invented from scrollback.
- No agent that manages other agents. The manager is a person.
- No feature that needs the browser tab to stay open to be correct.

## How to proceed

1. **Read.** The four documents named above, plus `web/src/views/list.ts` and
   `server/src/instances/service.ts` -- the briefing mechanism you need is
   already in there, used by the upload and the model switch.
2. **Write EPIC 3** as one issue in the EPIC shape from `ticket-writing`: goal,
   the sketch above, the handful of core decisions, the order. Short.
3. **Write the work packages** below as sub-issues of it, in the house format.
   Where my scope lines are wrong for what you found in the code, correct them
   and say so -- I wrote them from the outside.
4. **Implement them in order, one PR each**, and close each one out with the
   `ticket-closeout` checklist: gates run and pasted, `knowledge/` updated,
   `wiki/` updated. #1 and #2 are the keystone; everything after them is worth
   less until they exist.
5. Ask before starting if any package below turns out to be two packages, or if
   two of them are one.

## The work packages

Titles are one line and imperative; the scope lines are the deliverables; the
criteria are what somebody else can check from the outside.

### 1. Brief an instance without opening its console

The keystone. Everything else is an interface onto this.

- `POST /instances/:id/prompt`: a briefing goes into the session and is submitted
- refused with `409` when there is no ready session, the way `PATCH` already is
- a multi-line briefing arrives as **one** prompt, not as one submit per line
- the list gets a briefing box per instance; the create form gets a first briefing
- constraint: the TUI reads Enter as submit; see
  `knowledge/send-keys-needs-the-pane-not-the-session.md` and the pause it needs

Criteria: `tmux capture-pane` shows the briefing as one prompt; a three-line
briefing moves the activity to `running` exactly once; quotes, backticks and `$`
arrive verbatim; no session answers `409` and types nothing.

### 2. Assignments: a briefing outlives the instance that got it

- an assignment table: project, title, briefing, state, instance, timestamps
- states `backlog → assigned → done`, plus `cancelled`; the instance's activity
  is what advances the last step, nothing is typed twice
- REST for create, list, dispatch and cancel
- dispatching picks a free instance of that project or creates one

Criteria: an assignment survives a server restart; deleting its instance leaves
the assignment with a state and no instance rather than deleting it; two
dispatches never brief the same instance twice.

### 3. Hire for a role, on top of the project

A role is a job description, not a workplace: "reviewer" means the same thing on
every project, and the project keeps deciding the repository and the environment.
The two are orthogonal -- an instance has both, and neither replaces the other.

- a catalogue of roles: a name and a briefing preamble, reusable across projects
- a project may add its own roles; it never loses the shared ones
- chosen next to the project when an instance is created, shown on the board
- the preamble is prepended to the first briefing, not written into the clone --
  the repository's own `CLAUDE.md` belongs to the repository

Criteria: one role is usable on two projects with different environments; the
role is visible on the list without opening a console; the preamble reaches the
session once and not on every following briefing; a role cannot set a repository,
an environment block or a managed variable.

### 4. Give a project a standing brief

A repository's own `CLAUDE.md` covers the repository. What it does not cover is
what this *project* knows and the repository must not say: the staging URL, the
colleague to ask, the convention that is not written down anywhere, the wiki
worth reading first. Without a place for it, a manager types the same paragraph
into every new console.

- a standing brief on the project: free text, editable, versionless
- every instance of that project gets it once, before its first briefing
- it is context, not configuration -- it cannot set a variable or a host, and
  it is not a secret, so it comes back out of the API as it went in
- reaches the container as a file next to the clone, not inside it

Criteria: a new instance of a project with a standing brief knows it without
anyone typing; two projects have different ones at the same time; editing it
does not touch instances that are already running; it never lands in the
repository's `git status`.

### 5. Say what the instance produced, in git terms

- `GET /instances/:id/git`: branch, upstream, ahead/behind, dirty count, last commit
- shown on the board and on the console page
- a Push action, through the credential helper the project's PAT already feeds

Criteria: a fresh clone reports clean and 0/0; a commit inside the container
shows as ahead 1 within one poll; Push makes the branch appear on the remote; an
instance whose clone failed reports "no repository" rather than a 500.

### 6. Let the backlog be GitHub

- `GET /projects/:id/issues` through the project's PAT, from the **server**, not
  from the instance
- dispatch an issue as an assignment with a generated briefing that names it
- the assignment keeps the issue number

Criteria: the open issues of a project's repo are listed; a project without a PAT
says so instead of failing; the created assignment carries the number and shows
it on the board.

### 7. Give the NUC a headcount

Four gigabytes per instance and one small box: the tenth instance is not a
slower machine, it is a dead one.

- a cap on running instances, configurable, default derived from the memory limit
- `POST /instances` and `/start` refuse above it and say what is running
- an assignment above the cap waits in `backlog` instead of failing

Criteria: with the cap at one, a second start answers `429`; stopping one lets
the waiting assignment run; the cap counts running containers, not rows.

### 8. Send an idle instance off shift

- an instance whose activity has been `done` or `idle` for a configured time is
  stopped -- stopped, never deleted, the workspace is the work
- opt out per instance; `0` disables it
- the list says it was stopped for being idle, not merely that it is stopped
- **decide and record**: this needs the first timer in the server. Either argue
  in `knowledge/` why it is not the poller the architecture rejected, or find a
  way to hang it off work that already happens.

Criteria: an instance past the timeout is `exited` and starts back up with its
workspace; an instance in `needs_input` is never stopped; the setting off means
nothing is ever stopped.

### 9. Escalate a question that nobody is looking at

Browser notifications need an open tab and a secure context -- see
`knowledge/notifications-need-a-secure-context.md`. A manager who closed the
laptop is the normal case, not the exception.

- a webhook posted to when an instance has been in `needs_input` longer than N
- one post per episode, not one per poll
- the payload names the instance, its project, its assignment -- no secrets

Criteria: one post for one question, however long it waits; none for an instance
that answers itself; a failing webhook is logged and never blocks the list.

### 10. One board instead of twenty consoles

- the landing page becomes a board grouped by activity, across all projects
- a card carries name, project, role, assignment, elapsed time and the last line
  of the pane
- answering a `needs_input` from the card, without opening the console (#1)
- the table stays reachable for the operator's view

Criteria: twenty instances are readable without scrolling into a second screen;
the card's state matches what the console shows within one poll; a card with a
question is answerable from the board.

### 11. Keep the timeline, not just the current state

- the hook events appended to a table: instance, event, timestamp
- `GET /instances/:id/timeline`, shown on the console page
- the current activity still comes from memory -- this is history, not state
- **decide and record**: this is the second thing the database holds beyond
  identity. `knowledge/database-holds-identity-docker-holds-state.md` has to be
  answered, not ignored.

Criteria: an event survives a server restart; deleting an instance takes its
timeline; stopping the server mid-turn does not leave a lying "running" behind.

## One package outside the EPIC

**Run the gates in CI.** There is no `.github/workflows` in this repository at
all. Rule 2 says no PR before lint, `tsc --noEmit` and the tests have passed, and
today nothing but discipline enforces it. A workflow that runs the three on every
PR -- and the docker smoke tests wherever a runner can -- makes the rule real. Do
this one first; it costs an hour and it guards every package above.

## Rules of engagement

- One ticket, one branch, one PR: `feature/dz/<ticket>`.
- No PR without the gates actually run and their output pasted into `## Gates`.
- Every user-visible change updates `wiki/`, and the board changes what a user
  sees on every single package -- "nothing user-visible" will rarely be the
  honest answer here.
- Every pitfall that cost you an hour goes into `knowledge/` as one file, indexed.
- Keep the tickets short. If a body needs more than 25 lines, it is two tickets.
