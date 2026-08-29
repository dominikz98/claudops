# A file comes out of a container through `getArchive`, never through `cat`

**Fact.** `DockerodeEngine.readFile` asks Docker for a tar stream and parses it.
The obvious alternative -- `runCommand(['cat', path])` -- cannot work: an exec's
output is decoded as UTF-8 on the way out, and a PNG does not survive that.

**Why.** `collectOutput` ends with `Buffer.concat(chunks).toString('utf8')`,
because every other caller of `runCommand` wants a string: a `find -printf`, a
`stat`, a `tmux send-keys`. Any byte sequence that is not valid UTF-8 becomes
U+FFFD there, and one replacement character is three bytes where the original
was one -- so the length is wrong too. The corruption is silent and looks like a
broken image rather than like a broken read, which is what makes it expensive:
`cat` on a text file works perfectly, so the mistake only shows up on the first
screenshot.

Widening `runCommand` to hand back bytes was the alternative. It loses: the
demultiplexing (`knowledge/a-non-tty-exec-is-framed.md`) would then have to be
undone by every caller, and `getArchive` is one round trip instead of an exec
plus its exit code.

The tar is not overhead, it is the size limit. The header states the entry's
size before its body arrives, so `readFirstEntry` refuses an oversized file
after 512 bytes and the caller destroys the stream -- a three-megabyte heap dump
never enters the server's heap. A `cat` would have to be read to the end to
find out how long it was.

Two consequences worth knowing. The archive of a directory starts with a
directory entry, so "somebody asked for a folder" is an answer the reader gives
rather than a case the caller has to pre-empt. And the entry for a symlink is
the link, not its target -- which is why the last component of a path is
refused if it is one.

**Applies to.** `server/src/docker/dockerode-engine.ts` (`readFile`),
`server/src/docker/tar.ts` (`readFirstEntry`), issue #18.
