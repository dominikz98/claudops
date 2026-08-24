# The Claude auth token is an OAuth token, never an API key

**Fact.** Instances authenticate through `CLAUDE_CODE_OAUTH_TOKEN`, obtained once
via `claude setup-token` and injected from the server config as an environment
variable. `ANTHROPIC_API_KEY` is deliberately never set alongside it. No
`~/.claude` directory is mounted into the container.

**Why.** A present `ANTHROPIC_API_KEY` overrides the subscription and usage gets
billed per token instead. Mounting `~/.claude` would share one credential store
and its session state across all instances. The token must not reach the database,
the logs or any API response -- it lives in the server config and in the container
environment only.

**Applies to.** `docker/base/Dockerfile`, `docker/base/README.md`, issues #3, #9.
