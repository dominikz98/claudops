# Verify line endings with cat-file and byte counting, not with grep

**Fact.** To check whether a file in this repository really has LF endings, use
`file`, `od -c`, or `tr -dc '\r' | wc -c`. To check what is stored in a commit,
use `git cat-file blob "$(git rev-parse HEAD:path)"`. Two shortcuts that look
right and are not: `grep -c $'\r' file`, and `git show HEAD:path`.

**Why.** In Git Bash `$'\r'` reaches grep as an empty pattern, so `grep -c`
matches every line and returns the *line count* -- a 108-line LF file reports
"108 CR" and looks thoroughly broken. And `git show HEAD:path` applies checkout
filters, so it can show CRLF for a blob that stores LF, or the reverse. Both
mistakes point the same way: at a CRLF problem that does not exist. The `eol=lf`
rule in `.gitattributes` guards the shebang inside the container, so a false
alarm here invites a "fix" that breaks the thing it was meant to protect. The
cheapest cross-check is the smoke test: if the container starts at all, the
shebang parsed, so the entrypoint had LF.

**Applies to.** `.gitattributes`, `docker/base/*`, and any close-out that claims
a line-ending gate. Related: [The dev host is Windows, the target is Linux](windows-dev-host-linux-target.md).
