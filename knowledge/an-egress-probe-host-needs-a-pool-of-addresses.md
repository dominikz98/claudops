# A host used to probe the egress whitelist has to answer with a pool of addresses

**Fact.** A test that whitelists a hostname and then curls it from inside the
container fails intermittently when that name answers with *one* address that
rotates. `api.nuget.org` is such a name: every lookup hands back a single Azure
Front Door address, and it changes within minutes. The firewall freezes the
address it resolved into the ipset, the probe resolves the name again seconds
later, gets a different one, and is refused by the very whitelist that was
supposed to allow it. Names that answer with their whole pool -- `pypi.org`,
`files.pythonhosted.org`, `index.crates.io`, `dot.net`, four or five addresses
each -- survive a rotation, because the ipset holds all of them.

**Why.** The symptom reads exactly like a broken feature: `FIREWALL_ALLOW`
arrives in `docker inspect`, the firewall reports `active`, the server-wide host
works, and the project's host is refused. Nothing in the log says which address
went into the set and which one curl asked for, so the obvious conclusion is that
the project's half of the whitelist never arrived.

It also affects operation, not only tests: a project whose egress host is a
single-address CDN name will see occasional refusals until the container's
15-minute re-resolve catches up (the loop at the end of `init-firewall.sh` is
what exists for this). Preferring a name whose answer is a pool -- or listing a
CIDR -- is the way around it.

A second reason not to probe with `api.nuget.org` in particular: the dotnet
building block writes it into `/etc/claudops/firewall-allow.d/10-dotnet.conf`, so
under `FULL_IMAGE=1` the assertion would pass without the project's list doing
anything at all.

**Applies to.** `server/smoke-test.sh`, `docker/base/smoke-test.sh`,
`docker/base/init-firewall.sh`, issue #32.
