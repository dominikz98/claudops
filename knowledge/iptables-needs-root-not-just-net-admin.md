# iptables needs root, not just NET_ADMIN

**Fact.** `--cap-add=NET_ADMIN` puts the capability in the container's *bounding*
set. A uid-1001 process gets nothing from that, so the entrypoint -- which runs
as `claude` -- cannot call `iptables` at all. It reaches it through one
`NOPASSWD` sudoers entry scoped to `/usr/local/bin/init-firewall.sh` with no
arguments. Verified: `docker exec <container> iptables -L` as `claude` exits 4.

**Why.** The alternative that lost is `setcap cap_net_admin+ep` on the iptables
binary: it removes the sudo dependency but hands the agent permanent,
unrestricted iptables, which is strictly worse than one argument-less command.
The other alternative -- `USER root` in the Dockerfile plus a privilege drop for
the tmux session -- ripples much further: `docker exec` arrives as root unless
the engine sets `User` on every exec, `/workspace/<repo>` ends up owned by root,
`HOME` and the tmux socket path move, and Claude Code refuses
`--dangerously-skip-permissions` as root anyway.

A corollary worth keeping: the legacy iptables backend opens an `AF_INET`/
`SOCK_RAW` socket and so also needs `CAP_NET_RAW` -- but that one is already in
Docker's default set. Only `NET_ADMIN` is added, and no `CapDrop` may ever be
introduced without checking this again.

**Applies to.** `docker/base/Dockerfile`, `docker/base/entrypoint.sh`,
`server/src/docker/engine.ts` (`ContainerSpec.capAdd`),
`server/src/instances/service.ts` (`INSTANCE_CAPABILITIES`), issue #9.
