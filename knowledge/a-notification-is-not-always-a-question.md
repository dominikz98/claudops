# A `Notification` hook is not always a question

**Fact.** Claude Code's `Notification` hook fires both when Claude is waiting for
an answer *and* when the prompt has simply been idle for sixty seconds. The
payload's `notification_type` is what tells them apart:
`permission_prompt` and `elicitation_dialog` are questions, `idle_prompt`,
`auth_success` and `agent_completed` are not. `claudops-status` passes the type
through and `ActivityTracker` decides.

**Why it matters this much.** Every finished instance reaches the idle case a
minute after it goes quiet. Reading `Notification` as "needs input" on its own
would therefore turn the whole list amber a minute after it went quiet -- with a
browser notification each -- which is precisely the opposite of what the badge is
for. It also looks fine in every short test: the nag only arrives after sixty
seconds.

**The rule for a type nobody has seen.** A release that adds a value must not
silently become a false alarm, so an unknown type counts as a question only while
a turn is in flight. A notification *during* a turn is Claude interrupting itself
to ask; one after it is far more likely to be the nag. Being wrong in that
direction costs a missing badge, not a wrong one.

**The other half.** `--dangerously-skip-permissions` means `permission_prompt`
never fires in a claudops container, so the question that does arrive is
`elicitation_dialog`. The list is deliberately not narrowed to it: the flag is a
decision an image could revisit, and a permission prompt is a question either
way.

**Applies to.** `server/src/instances/activity.ts`,
`docker/base/claudops-status`, `server/test/activity.test.ts`, issue #17.
