# A firewall script must fail closed, and say so when it cannot

**Fact.** `init-firewall.sh` resolves every name and fetches GitHub's ranges
*before* it flips the policies to DROP, and an `EXIT` trap seals the namespace to
loopback on every path that is not success. Where even sealing is impossible it
writes state `unfiltered` rather than `failed`, because setting a policy is
itself an `iptables` call: without `CAP_NET_ADMIN` the container cannot be
restricted at all.

**Why.** Anthropic's `.devcontainer/init-firewall.sh`, which this is modelled on,
`exit 1`s between the flush and the policy change -- GitHub meta unreachable, one
name that will not resolve, no default route. At that point the rules are gone
and the policies are still `ACCEPT`, so it **fails open while reporting
failure**. That is the one behaviour claudops cannot inherit, because the whole
reason `--dangerously-skip-permissions` is acceptable is the isolation.

The two-token state file exists because the first version of this claimed a seal
it did not have: the log said "the container is sealed off" while
`curl https://api.github.com` still worked, since the seal needs the same
capability that was missing. A message that is wrong exactly when it matters is
worse than no message.

Two substitutions keep the image thin and are easy to get wrong when copying the
reference: `getent ahostsv4` (libc, always present) instead of dnsutils' `dig`,
and `jq`'s `select(contains(":")|not)` instead of `aggregate` for dropping IPv6.
And only the `filter` table is flushed, so Docker's nat redirect for
`127.0.0.11` -- the embedded DNS resolver -- survives untouched, which is what
makes the reference's save-and-replay dance unnecessary.

**Applies to.** `docker/base/init-firewall.sh`,
`docker/base/entrypoint.sh` (`setup_firewall`, and withholding Claude when it
fails), `docker/base/smoke-test.sh`, issue #9.
