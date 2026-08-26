# Reading /proc/1/environ in a container needs CAP_SYS_PTRACE

**Fact.** Root inside a claudops container cannot read `/proc/1/environ`: it
fails with `Permission denied`. Reading another user's environment block passes a
`PTRACE_MODE_READ_FSCREDS` check, which root satisfies through `CAP_SYS_PTRACE`
-- and that capability is **not** in Docker's default set. PID 1 here is the
entrypoint running as `claude` (uid 1001), so a root helper reaching for its
environment gets nothing.

**Why it cost time.** `/proc/1/environ` looked like the ideal way to hand
`REPO_URL` and `FIREWALL_ALLOW` to `init-firewall.sh`: `sudo` resets the
environment and the sudoers entry forbids arguments, so PID 1's environment is
the one channel no process in the container can rewrite. The script ran, the
firewall came up, the probes passed -- and `REPO_URL` was silently empty, so the
repo host never reached the whitelist. It only showed up as
`init-firewall.sh: line 65: /proc/1/environ: Permission denied` in
`docker logs`, and only because the clone happened to work anyway: the test repo
was on GitHub, whose ranges the whitelist gets from `api.github.com/meta`. A
GitLab repo would have failed to clone with no obvious cause.

The same limit hits `>/proc/1/fd/1`, which was how the background re-resolve loop
was meant to get its output into `docker logs`. It does not need it: the loop
inherits the container's stdout through sudo and survives the script's exit.

What replaced it is a scoped `env_keep` in
`/etc/sudoers.d/claudops-firewall`. That is not weaker, because the barrier was
never the transport: a second invocation is refused by the sentinel chain before
a single variable is read
([firewall-sentinel-is-an-iptables-chain.md](firewall-sentinel-is-an-iptables-chain.md)).

**Applies to.** `docker/base/init-firewall.sh`, `docker/base/Dockerfile`
(the sudoers entry), issue #9.
