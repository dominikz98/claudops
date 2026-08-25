# Fastify silently strips unknown request fields unless told not to

**Fact.** The server is built with `ajv: { customOptions: { removeAdditional:
false } }`. Without it, `additionalProperties: false` in a body schema does not
reject an unknown field -- Fastify's Ajv default is `removeAdditional: true`, so
the field is deleted and the request succeeds.

**Why.** The symptom is a passing request where a rejection was expected: a
`POST /instances` carrying `env: { ANTHROPIC_API_KEY: ... }` answered 201, and
nothing in the response said the field had been dropped. Stripping is the safer
of the two silent options -- the key never reached the container -- but a caller
who misspells `repoBranch` gets an instance on the wrong branch and no hint why.
For an API whose fields decide what a container is handed, "rejected loudly"
beats "quietly ignored".

**Applies to.** `server/src/app.ts`, `server/src/instances/routes.ts`, issues
#3, #6.
