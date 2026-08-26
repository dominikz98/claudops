# Do not whitelist the docker bridge

**Fact.** The egress whitelist contains no part of the container's own subnet.
Only the nameservers from `/etc/resolv.conf` are allowed, on port 53. An instance
therefore reaches neither `172.17.0.1:8080` -- the claudops API on the gateway --
nor any neighbouring instance on the bridge.

**Why.** Anthropic's reference `init-firewall.sh` derives `HOST_IP` from
`ip route | grep default` and ACCEPTs that whole `/24` in both directions,
because a devcontainer wants to talk to the IDE on its host. Copied here that
rule hands every instance the claudops REST API: create, stop and delete other
instances, read every project. It also opens each instance to its neighbours.
Both are a plain violation of "reaches whitelisted domains and no others", and
claudops needs none of it -- the terminal bridge is a `docker exec`, not a TCP
connection into the container.

Dropped for the same reason: the reference's blanket
`OUTPUT -p tcp --dport 22 -j ACCEPT`. claudops clones over HTTPS through the
credential helper, so an open SSH port to anywhere is an exfiltration channel and
nothing else.

The smoke test asserts both directions of this -- that the gateway is not in the
ipset, and that a request to it actually fails -- because a whitelist regression
here is invisible from inside the container.

**Applies to.** `docker/base/init-firewall.sh`, `docker/base/smoke-test.sh`,
`wiki/architecture.md`, issue #9.
