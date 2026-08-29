# What an instance produced is served as text or as a download, never as a document

**Fact.** `GET /instances/:id/files/content` answers with one of three content
types: an image from a short allowlist, `text/plain; charset=utf-8`, or
`application/octet-stream` as an attachment. `text/html` and `image/svg+xml`
are deliberately never sent, whatever the file is called.

**Why.** This route serves bytes an agent wrote, from claudops' own origin, to
a browser carrying the operator's session cookie. An HTML file is exactly the
kind of thing Claude produces -- a coverage report, a Playwright trace, a
generated page -- and serving one as `text/html` runs its script with access to
every claudops endpoint the operator can reach. SVG is the same hazard wearing
an image's name: it is a document that carries script, which is why it is not
in the image allowlist and arrives as text instead. Nothing is lost: the panel
renders Markdown itself, from text, in the browser.

Three headers back this up rather than replace it. `X-Content-Type-Options:
nosniff` keeps the browser on the type the server chose instead of guessing from
the bytes. `Content-Security-Policy: default-src 'none'; sandbox` makes a tab
opened directly on the URL an origin-less sandbox. `Content-Disposition:
attachment` on everything that is not inline-safe means the browser saves it
rather than showing it.

Whether the bytes are text is decided by the bytes, not by the extension: valid
UTF-8 without a NUL is text. A name says nothing reliable -- an agent writes
`.log` files that are gzip and `.txt` files that are UTF-16.

**Applies to.** `server/src/instances/files.ts` (`contentTypeOf`,
`IMAGE_TYPES`, `looksLikeText`), `server/src/instances/routes.ts`, and
`web/src/markdown.ts`, which escapes every character before it parses anything
for the same reason. Issue #18.
