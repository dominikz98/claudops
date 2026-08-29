# A directory listing read through an exec has to be NUL-separated

**Fact.** `LIST_SCRIPT` prints `find -printf '%y\t%s\t%T@\t%f\0'`, and
`parseListing` splits on NUL and takes the entry name as *everything after the
third tab* rather than as the fourth field.

**Why.** A Linux filename may contain every byte except `/` and NUL -- a
newline and a tab included, and an agent that writes files from a script
produces both by accident. A line-based listing loses the entry after a name
with a newline in it, and a naive four-way split on tab truncates a name with a
tab in it. Neither failure looks like a bug: the listing simply has fewer
entries, or one entry has a shorter name, and nothing reports an error. NUL is
the one separator a filename cannot contain, which makes the framing
unambiguous by construction rather than by escaping.

`%y` and not `%Y`: the type of the entry itself, so a symlink stays a symlink in
the listing instead of quietly becoming what it points at
(`knowledge/a-server-side-path-check-cannot-see-a-symlink.md`).

The rest of the script's shape has the same origin. `2>/dev/null` on the `find`,
because `runCommand` merges stderr into the same buffer as stdout and one
"Permission denied" would be parsed as an entry. `-maxdepth 1`, because the
workspace holds a clone with its `node_modules` and a recursive walk is
megabytes of exec output for one click. And `head -z -n <limit + 1>`, so
"there are more" is known from the count rather than guessed from a full page.

**Applies to.** `server/src/instances/files.ts` (`LIST_SCRIPT`, `parseListing`),
issue #18. `usedUploadBytes` in `server/src/instances/service.ts` uses the same
`find -printf` shape for a different reason -- see
`knowledge/a-non-tty-exec-is-framed.md`.
