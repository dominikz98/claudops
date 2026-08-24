# Git tokens reach the container through a credential helper

**Fact.** `GIT_TOKEN` is served by `git-credential-claudops`, a helper that reads
the token from the environment and answers `get` requests. `GIT_TOKEN_HOST`,
derived by the entrypoint from `REPO_URL`, restricts which host the helper
answers for.

**Why.** A token embedded in the clone URL persists in `.git/config`, shows up in
`git remote -v`, and leaks into the error messages git itself prints -- all of
which land in the instance console the user is watching. The host restriction
means a clone against a foreign host, e.g. from a submodule or an injected
command, never sees the token. The username defaults to `x-access-token`; GitHub
accepts any value next to a PAT.

**Applies to.** `docker/base/git-credential-claudops`,
`docker/base/entrypoint.sh`, issues #6, #9.
