# The dev host is Windows, the target is Linux

**Fact.** `.gitattributes` pins `*.sh`, `*.conf`, `Dockerfile`, `.dockerignore`
and `git-credential-*` to `eol=lf`. The smoke test exports `MSYS_NO_PATHCONV=1`
and `MSYS2_ARG_CONV_EXCL='*'`, and converts the build context with `cygpath -w`
where available. The Dockerfile chmods the copied scripts to 0755 explicitly.

**Why.** Development happens on Windows, everything runs on Linux in the
container. A CRLF checkout breaks the shebang inside the image with the useless
"bad interpreter: no such file or directory". Git Bash/MSYS rewrites arguments
that look like absolute paths, so `/workspace/claudops` handed to `docker exec`
turns into a Windows path and the container check silently passes against
nothing. And the exec bit does not survive every Windows checkout, hence the
explicit chmod in the image rather than trusting the file mode in git.

**Applies to.** `.gitattributes`, `docker/base/smoke-test.sh`,
`docker/base/Dockerfile`.
