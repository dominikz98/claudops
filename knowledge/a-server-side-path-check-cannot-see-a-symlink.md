# A path check in the server is about a string; a symlink is about the container

**Fact.** `GET /instances/:id/files` checks a path twice, in two places, and
both are necessary. `resolveWorkspacePath` normalises it in the server and
refuses anything that does not resolve under `/workspace`. The shell scripts in
`server/src/instances/files.ts` then resolve it again *inside* the container
with `realpath` and refuse it a second time if what it points at has left the
workspace.

**Why.** The server's check is a statement about a string: it turns
`/workspace/../etc/passwd` into `/etc/passwd` and rejects it, and there is no
input it can be talked out of, because `..` is resolved rather than searched
for. What it cannot know is what the strings *mean* in that container.
`/workspace/notes.txt` is inside the workspace by every rule the server has --
and if the agent ran `ln -s /etc/passwd notes.txt`, reading it hands the
operator a file from outside. The same holds for a directory: a listing of
`/workspace/out` where `out -> /etc` is a listing of `/etc`.

So the second check has to run where the filesystem is. It is a `case` on
`realpath`'s answer against the workspace root, and it costs nothing: the exec
that lists or stats the path is already being made.

Two details that are easy to get wrong. The prefix comparison has to include
the separator -- `/workspacex/secrets` starts with `/workspace` and is not in
it. And the path reaches the script as `$1` with the workspace root as `$2`,
never interpolated into the script text: a directory really can be called
`"; rm -rf /; "`, and the path check says nothing about what a name would do to
a shell.

**Applies to.** `server/src/instances/files.ts` (`resolveWorkspacePath`,
`LIST_SCRIPT`, `STAT_SCRIPT`, `scriptCommand`), issue #18. The same reasoning in
the opposite direction is `uploadFileName` in
`server/src/instances/service.ts`, which sanitises rather than resolves --
an upload chooses its own name, a read does not.
