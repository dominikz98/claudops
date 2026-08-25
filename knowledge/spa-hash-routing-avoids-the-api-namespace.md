# The web UI routes in the hash because the path belongs to the API

**Fact.** The SPA and the REST API share one origin and one port. Its routes
therefore live in the fragment -- `#/i/<id>` for a console -- and never in the
path. `@fastify/static` is registered with `prefix: '/'` and no catch-all
rewrite.

**Why.** The obvious history route for a console would be `/instances/<id>`,
which is already the REST resource. Serving the SPA there would mean either
shadowing the API or branching on the `Accept` header, and adding an
`index.html` fallback for unknown paths would turn the JSON 404 into an HTML
page for every mistyped API call. With the routes in the hash the server needs to
know nothing about them: every page load is `GET /`, exact API routes keep
winning against the static wildcard, and `setNotFoundHandler` still answers
unknown paths with JSON.

**Applies to.** `server/src/app.ts`, `web/src/router.ts`. A future login (#9) or
projects UI (#6) inherits the same constraint.
