# Prompt: add the ticket pipeline to the mockup

A canvas for EPIC #36 already exists. This is a **delta, not a rebuild**: the
backlog grew four issues after that canvas was built, and they change what the
screens have to show. Keep everything else exactly as it is.

(If you are reading this together with `project-manager-mockup-revision.md` and
have not built from it yet, its fix 12 says the same thing -- do both in one
round and ignore the "read the canvas back" step below.)

---

## Read the canvas back before you change anything

Do not seed a fresh canvas. Read the published artifact, extract its artboards,
`canvas.json` and images into a clean directory, edit those files, and re-seed
from the complete set. Anything hand-tweaked in the editor since the last round
is somebody's work -- losing it is not a redesign, it is a deletion.

Then say in one line what you actually found: how many artboards, whether the
canvas already has pages, and whether anything below is already drawn. My list
assumes a canvas built from the revision brief; correct me where it is wrong
rather than building on my assumption.

## What changed in the backlog

| Issue | What it adds |
| --- | --- |
| #49 | An assignment runs an ordered list of roles: `planner`, `implementer`, `reviewer` |
| #50 | A stage is handed over with a written note and a pushed branch; the manager decides every hop |
| #51 | A ticket gets its own page: its stages, who held each, what note they left |
| #52 | Advancing without the manager, opt-in per project -- deliberately last, and may be closed unbuilt |
| #53 | A webhook for a ticket that stopped moving. **No screen of its own** -- the stall is already the backlog's third kind below; do not invent a page for it |

Plus: #36 gained a core decision ("a stage is a fresh worker, and the branch is
the handover"), and #46 gained a scope line for the stage chip and the backlog.

## The model, so the screens are not guesses

An assignment is not one worker's job. It runs through roles in order, and
**each stage is its own hire** -- a reviewer that is the implementer's own
session reviews its own reasoning, which is worth nothing.

A container dies with its workspace, so the workspace cannot be the handover.
What crosses between two stages is exactly two things: **a pushed branch** and
**a written note**. That produces a rule with teeth: a stage whose branch has
unpushed commits cannot be handed over at all, because the next worker starts
from that branch.

The manager decides every hop. Nothing flows on by itself.

## Four edits to artboards that already exist

### Board

- Each card gains a stage chip: `implementing 2/3`. A card with no assignment at
  all is legitimate -- an instance nobody has given a ticket to -- and it must
  look different from a card mid-pipeline, not merely lack a chip.
- **The FINISHED column now means two different things.** "The turn ended" and
  "this stage is finished and proposes a handover" are not the same state, and
  the second one is the one the manager acts on. Separate them -- a renamed
  column, a second chip, whatever reads fastest -- and make the one that wants a
  decision the one that draws the eye.
- A card links to its ticket's page in one click.
- An instance sent off shift mid-stage does not end its stage. Its card has to
  say that a ticket is stalled on it, not just that it is resting.

### Backlog

It now holds three kinds of work without a worker, and they are not the same
thing:

1. open GitHub issues nobody has picked up
2. assignments queued above the headcount cap (#43)
3. assignments sitting between two stages, waiting for their next hire

One list, three legible kinds. The third is the new one and the most urgent --
work already half done that has stopped moving.

### Console

The "what they produced" panel gains the handover note in full, and the same
three choices the card offers. The card is where a handover is decided at a
glance; the console is where the note is actually read before deciding.

### Hire

Hiring for a stage is not the same as hiring from scratch: the role is already
decided by the pipeline, and the briefing arrives pre-assembled from the role
preamble, the standing brief, the ticket and the previous stage's note. Show
that form with those fields filled and the role fixed -- and show that the
manager can still edit the briefing before sending it.

## Two new artboards

### `Handover.dc.html`

The moment itself, two states side by side in one artboard:

- **Ready.** The finishing instance's note, the branch with how far ahead it is
  and whether it is clean, then three choices: Hand over to review, Send back,
  Keep working. Make clear which is the ordinary one.
- **Refused.** The same card with commits that are not pushed. The handover
  button is disabled and says why *before* it is clicked -- a click that fails
  is a worse design than a button that explains itself.

### `Pipeline.dc.html`

The ticket's own page, and the only screen where the ticket is the subject
rather than an instance. Stages oldest first, each with its role, the instance
that held it, how long it took, the note it left and how it ended.

Three things it has to survive, so draw them:

- a stage whose instance was deleted long ago -- the note is still readable, the
  instance is a name and nothing more
- a role that appears twice, because a review sent the work back
- a current stage with no worker yet, and a current stage whose worker is off
  shift

This page is the ticket's history. An instance's own timeline (#47) is a
different thing and stays on the console -- do not merge them.

## Where the new artboards go

If the canvas has no pages yet, give it two: **Flow** (board, backlog, hire,
answer, handover, pipeline -- the manager's loop) and **Screens** (the surfaces
it runs on). Launch on Flow. If it already has pages, slot the two new artboards
into whichever holds the board, and leave the rest of the layout alone.

## What not to touch

The palette, the type, the card anatomy, the badge shapes and every artboard not
named above. This is an addition to a canvas that works, in the same vocabulary.
If something below tempts you into a broader redesign, finish the addition and
say what you would change instead of changing it.

## What not to draw

An automatic pipeline. Nothing advances without the manager -- #52 is the single
ticket that argues with that, it is scheduled last, and it may well be closed
unbuilt. A screen that shows work flowing on by itself is describing a product
this EPIC decided against.
