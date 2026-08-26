# The firewall's re-run guard is an iptables chain, not a file

**Fact.** `init-firewall.sh` refuses to run twice by checking whether the chain
`CLAUDOPS-EGRESS` already exists, and it does so *before* it installs its
seal-on-exit trap. A second invocation exits 3 without touching a rule.

**Why.** This is what makes the whole privilege model hold. The agent runs as
`claude` with `--dangerously-skip-permissions` and can invoke
`sudo -n init-firewall.sh` itself; the guard means that invocation changes
nothing, whatever environment it brings. Verified: a re-run exits 3, and a re-run
with `FIREWALL_ALLOW=evil.example` in the environment also exits 3.

A marker file under `/run` was the obvious alternative and is exactly backwards.
`/run` is an ordinary directory in this image's read-write layer, so a file there
survives `docker stop` / `docker start` while the network namespace does not: the
guard would refuse after a legitimate restart, and permit after a hostile flush.
The chain lives in the netns, which takes `CAP_NET_ADMIN` to touch -- so the
unprivileged agent can neither remove it nor forge it, and a restart clears it
along with the rules it guards.

The ordering matters as much as the mechanism: the check has to sit before
`trap on_exit EXIT`, or a refused re-run would seal a container whose firewall
was perfectly fine.

**Applies to.** `docker/base/init-firewall.sh`, `docker/base/smoke-test.sh`,
issue #9. Related:
[a-firewall-script-must-fail-closed.md](a-firewall-script-must-fail-closed.md).
