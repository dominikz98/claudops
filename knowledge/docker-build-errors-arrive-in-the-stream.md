# A failed image build answers HTTP 200 and reports the failure in the body

**Fact.** `POST /build` on the Docker Engine API -- `docker.buildImage()` in
dockerode -- answers `200` as soon as the build *starts*. Whether it worked is in
the response body, which is newline-delimited JSON: ordinary output arrives as
`{"stream":"Step 2/3 : RUN ..."}` and a failure as
`{"errorDetail":{"message":"..."},"error":"..."}`. Awaiting the request and
moving on therefore makes every build look successful, including one that never
produced an image.

**Why it matters here.** `server/src/docker/dockerode-engine.ts` reads the
stream to its end (`drainBuildLog`), hands every line to a callback and turns the
first error line into an `ImageBuildFailedError`. Two things fall out of that and
are worth keeping:

- The log has to be collected while the stream is being read anyway, so it is the
  same pass that answers "did it work" -- there is no second chance to get the
  output of a build that failed.
- A line can straddle two chunks. Parsing per chunk instead of per line throws
  away whichever step was unlucky.

The same shape applies to `POST /images/create` (pull) and to
`followProgress`, which dockerode offers for exactly this reason -- it is not
used here because the parsing is fifteen lines and `modem` is typed as `any`.

**Applies to.** `server/src/docker/dockerode-engine.ts`, issue #7.
