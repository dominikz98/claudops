# Prompt: fix the project manager mockup

A first round of mockups exists for EPIC #36: a board, a project page and a
console. It is a good start on the visual language and wrong on structure. This
is the correction brief for the second round -- read it against the three
screens you produced, then rebuild the canvas.

---

## The one mistake behind most of the others

**The mockup treats EPIC #36 as a replacement for the app. It is an addition.**

Everything in the table below already ships, is tested, and has a closed issue
behind it. The first round silently dropped all of it. Nothing here is up for
redesign in this EPIC -- it is the app the new board is being added *to*.

| Deleted in round one | Ships since |
| --- | --- |
| The instance table -- name, status, project, model, repo, branch, age | #20, #33 |
| The files panel next to the terminal: tree, Markdown, images, download | #18 / #34 |
| The Attach button and paste/drop into a running instance | #15 / #30 |
| The model and effort dropdowns, switchable while running | #16 / #31 |
| Project create, edit, delete; rebuild; the build log | #6, #7, #25 |
| Stop, start and delete on an instance | #8 |
| The Alerts button and Log out in the header | #17, #9 |

Put every one of them back. If a new panel needs the space one of them occupies,
the new panel is what moves.

## What round one got right -- keep it

- The dark palette, the monospace for identifiers, the badge shapes. They come
  from `web/src/styles.css` and they are correct; do not re-derive them.
- The four columns as the board's organising idea: a question, working,
  finished, off shift.
- The card anatomy: name, role chip, elapsed, project, branch, the issue it is
  on, one line of what is happening, then the actions.
- Amber for "has a question" and only for that. It is the one state that is
  about the manager rather than about the instance.
- A question answered from the card. That is the whole point of the board.
- `Answer` as the primary action on a question card, `Brief` on a working one.
- The timeline as a list of hook events with timestamps.
- The standing brief as a plain textarea with a Save.

## The structural fixes

### 1. The nav is wrong

`Board | Projects | Console` implies one console. There is one console **per
instance**, reached from a card or a table row -- never from a nav bar.

Make it `Board | Instances | Projects`, with Alerts and Log out on the right
next to the headcount. The console is a page you arrive at, not a destination
you pick.

### 2. Every list is missing its list

The board says "two projects" and names `tecvia-web`. The project page shows
`claudops` alone, with no way to reach the other one. Same for roles: they are
rendered as a read-only column with no way to add, rename, edit a preamble or
remove one.

Every collection needs a list and a detail:

- **Projects**: the table that exists today (name, repository, branch, image,
  token, instances) plus a row for the standing brief, and a create form. One
  project's detail is a second artboard.
- **Roles**: a list with add, edit and remove. A role's preamble is a textarea,
  because that is what it is. Shared roles and this project's roles are two
  groups in one list, and a shared role cannot be edited from a project.
- **Instances**: the operator's table, still there, still complete.

### 3. Read-only where the app writes

`WHERE THE WORK HAPPENS` shows repository, branch, PAT, blocks, variables and
egress as static text. All six are editable today. Give them the affordance
they have -- and keep the write-only rule visible in behaviour rather than in a
footnote: a PAT and a variable show that one is set, never a value.

### 4. The backlog is not an instance state

Round one nests `BACKLOG` inside the `OFF SHIFT` column. An assignment nobody
has picked up is not an off-shift instance; putting it there says it is.

Give the backlog its own place: a strip above the columns, or its own page next
to the board. It holds the project's open GitHub issues and the assignments
waiting above the headcount cap, each with one action -- hire for this.

### 5. The board shows one axis of three

An instance has three states at once: what Docker says, whether its tmux
session is up, and what Claude is doing. Round one draws only the third, so
these have nowhere to appear:

- `starting` -- container up, session not yet, console not openable
- `failed` -- the container never reached its session
- `missing` -- a row with no container; only Delete is left
- `exited` by hand, as opposed to sent off shift

Design them. A card whose console cannot be opened yet has to say so, and
`missing` is the one state that is red.

### 6. Nothing shows an empty room or a broken one

Every screen is a happy path with plausible data. The states that need design
most are the ones nobody drew: no projects yet, no instances yet, an image whose
build failed with its log, a webhook that could not be reached, a push that was
rejected.

Draw at least the first run -- no projects, no instances -- and one failure.

## The copy fixes

### 7. Take the design notes off the page

Every panel in round one ends with a sentence explaining the design decision:

> "A PAT and a variable are write-only. The board never shows a value, only that
> one is set."
> "A role is a job description, not a workplace. It cannot set a repository, a
> block or a variable."
> "Open issues, read by the server through the project's PAT. Above the cap an
> assignment waits here instead of failing."
> "History, kept in the database. The current activity still comes from memory."

Those are notes to me, and they are correct -- they belong in the ticket and in
`knowledge/`, never in the interface. A UI that has to explain its own
architecture has lost the argument. Delete all of them.

### 8. No API vocabulary in the interface

"409 if no session is ready" is a status code in a hint text. Say what the
person sees: the Send button is disabled and says why -- "no session yet". Same
for "polled 3s ago" and anything else that describes the mechanism rather than
the state.

### 9. Use the real issue numbers

The cards carry #48, #50, #49, #12, #11, #9. The real ones exist: EPIC **#36**,
work packages **#37 to #47**, CI **#48**. Use them, with their real titles --
a mockup with invented numbers cannot be checked against the backlog it claims
to show.

### 10. Say what the headcount means

"headcount 7 / 8" next to a page that says "Eight instances" reads as though one
instance were missing. Seven running against a cap of eight is right; make the
two numbers unmistakable, and show what happens at 8 / 8.

## The layout fix

### 11. Fill the frame, and prove the claim

All three artboards use the top third and leave the rest empty. The board's
acceptance criterion is that **twenty instances are readable on one screen
without a second scroll region** -- eight cards in a third of the height proves
nothing either way.

- Board: twenty cards, 1440x900, filled. That is the test.
- Console: the terminal fills the height it has. Today's page is `100vh` with
  the split growing into it; a 300 px terminal above 500 px of nothing is not
  what gets built.
- Project detail: two columns that balance, or one that admits it is one.

## The artboards to produce

Ten, on one page, in this order:

1. `Board.dc.html` -- twenty cards, four columns, every state from fix 5, filled frame
2. `BoardEmpty.dc.html` -- first run: no projects, no instances, one way forward
3. `Answer.dc.html` -- answering a question from its card, before and after
4. `Instances.dc.html` -- the operator's table, complete, with the new columns
5. `Hire.dc.html` -- create an instance: name, project, role, model, effort, first briefing
6. `Backlog.dc.html` -- a project's open issues and the queued assignments, with hire
7. `Projects.dc.html` -- the project list plus the create form
8. `ProjectDetail.dc.html` -- editable fields, standing brief, the role list with add and edit, build log, rebuild, delete
9. `Console.dc.html` -- terminal, files panel, Attach, model and effort dropdowns, briefing box, what they produced, timeline
10. `Login.dc.html` -- the shared secret, and a wrong one

`Main.dc.html` is the board.

## How to work

Read the real source before drawing, not after: `web/src/styles.css` for every
value, `web/src/views/list.ts`, `projects.ts`, `console.ts` and `files.ts` for
what each page already contains and what its controls are called. Lift the
numbers -- padding, radii, font sizes -- rather than rounding them.

Then say in one line what you changed against round one, and name anything in
this brief you decided against and why.
