# Claude Code asks three questions on a first start, and a container is always a first start

**Fact.** A fresh instance opens on a wizard rather than on Claude unless
`~/.claude.json` already answers all three: the theme picker
(`hasCompletedOnboarding`), the workspace trust prompt
(`projects.<dir>.hasTrustDialogAccepted`) and the confirmation of
`--dangerously-skip-permissions` (`bypassPermissionsModeAccepted`). They appear in
that order, and each one blocks the next.

**Why.** The token is *not* what is missing -- `CLAUDE_CODE_OAUTH_TOKEN` logs in
without a prompt (see [auth-token-handling.md](auth-token-handling.md)), and the
wizard shows up in front of an authenticated Claude just the same. Reading the
theme picker as a login costs an afternoon.

Three findings that are not guessable:

- **A git repository is its own trust root.** An entry for `/workspace` covers an
  empty `/workspace/foo`, but not a `/workspace/foo` that is a clone -- Claude
  asks again for the repository. So the image can only seed `WORKSPACE_DIR`, and
  the entry for the clone has to be written by the entrypoint, which is the first
  thing that knows the directory name.
- **`theme` and `bypassPermissionsModeAccepted` do not survive.** Claude rewrites
  the file on every start and drops both. That is harmless: a second start stays
  at the prompt, so the acceptance is remembered elsewhere and neither field has
  to be re-seeded.
- **There is no CLI flag for it.** `--dangerously-skip-permissions` does not
  imply trust, and the only documented escape from the trust dialog is `-p`, which
  is non-interactive and therefore useless for a console.

`lastOnboardingVersion` is not needed, so nothing has to be derived from
`claude --version` at build time.

**Applies to.** `docker/base/Dockerfile`, `docker/base/entrypoint.sh`
(`trust_workspace`), `docker/base/smoke-test.sh`, issue #26.
