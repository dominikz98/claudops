# A repository's `.mcp.json` is a fourth first-start question, and `${VAR}` is how it gets its secret

**Fact.** A clone that brings a `.mcp.json` makes Claude Code ask whether to
trust the MCP servers it declares -- a fourth dialog on top of the three in
[claude-onboarding-must-be-pre-seeded.md](claude-onboarding-must-be-pre-seeded.md),
and one nothing in the instance list can answer. The image settles it with
`enableAllProjectMcpServers` in `~/.claude/settings.json`. A `${VAR}` in such a
file is resolved from the container's environment, which is where a project's
variables arrive.

**Why.** Without the flag the console opens on a trust prompt for a repository
that was cloned specifically to be worked on, and an instance whose work needs an
MCP server silently has none. Approving them wholesale is the same decision as
`--dangerously-skip-permissions`, not a new one: the servers come out of the
repository the container was created for, they run inside its isolation, and
their egress is the container's whitelist.

The `${VAR}` half is why a project's variables and its egress hosts are one
ticket: a server declared in a repository needs a token the repository must not
hold, and usually a host the base image does not whitelist. Both arrive per
project, neither is in the clone.

**Applies to.** `docker/base/claude-settings.json`, `docker/base/Dockerfile`,
`docker/base/smoke-test.sh`, issue #32.
