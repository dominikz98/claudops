# The dev host is Windows, the target is Linux

**Fact.** `.gitattributes` pins `*.sh`, `*.conf`, `Dockerfile`, `.dockerignore`
and `git-credential-*` to `eol=lf`. The smoke tests export `MSYS_NO_PATHCONV=1`
and `MSYS2_ARG_CONV_EXCL='*'`, and convert paths with `cygpath -w` where
available. The Dockerfile chmods the copied scripts to 0755 explicitly. The
server smoke test keeps two forms of every temporary path: the POSIX one for its
own `grep`/`rm`, and a `cygpath -w` one for every path it hands to `node.exe`.

**Why.** Development happens on Windows, everything runs on Linux in the
container. A CRLF checkout breaks the shebang inside the image with the useless
"bad interpreter: no such file or directory". Git Bash/MSYS rewrites arguments
that look like absolute paths, so `/workspace/claudops` handed to `docker exec`
turns into a Windows path and the container check silently passes against
nothing. And the exec bit does not survive every Windows checkout, hence the
explicit chmod in the image rather than trusting the file mode in git.

The two path forms are the same problem seen from the other side: the fix for
`docker exec`, `MSYS_NO_PATHCONV=1`, turns argument conversion off wholesale.
That is right for `docker`, but it also leaves `node.exe` reading `/tmp/...` as
`C:\tmp\...`. A server told to put its database there still starts happily, so
the damage shows up as a later check that finds no file and passes for the wrong
reason.

**Applies to.** `.gitattributes`, `docker/base/smoke-test.sh`,
`docker/base/Dockerfile`, `server/smoke-test.sh`.
