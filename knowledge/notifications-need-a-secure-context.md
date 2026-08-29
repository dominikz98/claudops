# The browser notification is the fallback, not the mechanism

**Fact.** The Notifications API needs a secure context. claudops is reached over
plain http on a LAN address, so in Chrome `window.Notification` is not merely
denied -- it is `undefined`. `web/src/notify.ts` therefore treats the tab title,
which counts the waiting instances, as the channel that always works, and the
notification as the one that may not exist.

**Why this is not "add TLS".** It would work -- a certificate and https would
bring the API back -- but that is a decision about how claudops is deployed, not
something the status badge may depend on. The title count needs no permission, no
certificate and no click, and it is visible from another tab, which is the case
the notification exists for in the first place.

**What it means for the UI.** The Alerts button reads `Alerts n/a` rather than
offering something the browser will not deliver, and says why in its tooltip. The
permission prompt is behind a click because browsers refuse one that nobody
asked for, and a page that asks on load is the page every user learned to
dismiss.

**Applies to.** `web/src/notify.ts`, `web/src/views/list.ts`, issue #17.
