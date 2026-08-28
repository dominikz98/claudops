# A raw body needs both a content-type parser and a route `bodyLimit`

**Fact.** `POST /instances/:id/files` takes the file as the body, and two
separate pieces of Fastify configuration have to be there for that:

- `addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, ...)`,
  because Fastify parses `application/json` and `text/plain` and refuses
  everything else with `415`.
- `bodyLimit` on the route, because the global default is **one megabyte** --
  which is a small screenshot, and the refusal would look like the upload limit
  being broken rather than like a default nobody set.

**Why.** The two are easy to confuse for one setting. `parseAs: 'buffer'` is what
makes the limit apply while the body is being read: Fastify checks
`content-length` up front and then counts the bytes as they arrive, aborts at the
route's limit and throws `FST_ERR_CTP_BODY_TOO_LARGE`. That error is an ordinary
object with a `code`, not a class the app can `instanceof`, so `app.ts` matches
on the code and maps it to the same `413 upload_too_large` as the server's own
`UploadTooLargeError` -- a client that has to shrink a file does not care which
of the two refused it.

The other half is that a parser must not be given its own `bodyLimit`: a limit
set there wins over the route's, and the route is the place that knows the
configured maximum. Registering the parser inside the instances plugin keeps it
off every other route.

One more consequence worth naming: a handler cannot assume its body is bytes just
because it declared a parser for them. `text/plain` still reaches the same route
as a *string*, so the handler checks `Buffer.isBuffer` and answers `415` --
without it a string would reach the tar writer and fail somewhere far away.

**Applies to.** `server/src/instances/routes.ts`, `server/src/app.ts`
(`isBodyTooLarge`), `server/src/config.ts` (`CLAUDOPS_UPLOAD_MAX_FILE`), issue
#15.
