# Overwriting a managed variable is not enough -- it has to be dropped

**Fact.** When a project's own environment variables are merged with the fixed
set claudops writes (`InstanceService.envFor`), a name from the fixed set has to
be *removed* from the project's map, not merely written after it. Writing the
fixed set last looks like it settles the question and does not.

**Why.** The fixed set is applied through a helper that leaves a variable out
when there is nothing to say -- no PAT configured, no model chosen, no status
listener, no server-wide whitelist. A project variable of that name then survives
in the empty slot, because nothing was written over it. The one that matters is
`ANTHROPIC_API_KEY`: claudops never sets it (it would override the subscription,
see [auth-token-handling.md](auth-token-handling.md)), so its slot is always
empty, and "the fixed set wins" would have handed a project exactly the variable
it must not have. `GIT_TOKEN` and `REPO_BRANCH` have the same hole whenever the
project has neither.

The refusal in `projects/env.ts` is the good error message -- a `409` naming the
variable -- but it is validation, and validation is not the guarantee. The filter
in `envFor` is.

**Applies to.** `server/src/instances/service.ts` (`envFor`),
`server/src/projects/env.ts` (`MANAGED_ENV_NAMES`), issue #32.
