# A container that withholds Claude may be hitting GitHub's rate limit, not a firewall bug

**Fact.** `init-firewall.sh` resolves GitHub's published ranges from
`https://api.github.com/meta`, unauthenticated. GitHub allows 60 such requests per
hour per IP, and every container start spends one. Past the limit `/meta` answers
`403`, the firewall fails closed, and the console shows "the egress firewall did
not come up" with Claude withheld -- on an image whose firewall is perfectly fine.

**Why.** The symptom points at the wrong place twice over. The pane blames the
firewall, and the state file (`failed`, `egress sealed: loopback only`) confirms
it, so the obvious next step is to debug iptables. The only line that names the
cause is in `docker logs`:

```
curl: (22) The requested URL returned error: 403
[firewall] ERROR: https://api.github.com/meta is unreachable.
```

A sealed container also cannot resolve anything, so the clone fails right after
with `Could not resolve host: github.com` -- a second red herring.

Running the gates burns the budget fast: `./docker/base/smoke-test.sh` starts
three containers, `./server/smoke-test.sh` and `./e2e/run.sh` several more, and
each start is one request. Two or three full gate rounds in an hour is enough.
`curl -s -o /dev/null -w '%{http_code}' https://api.github.com/meta` from the host
tells you in one line; `403` means wait, not debug. For a try-out that must work
now, `FIREWALL_MODE=off` skips the call altogether -- the operator's escape hatch,
never the agent's.

**Applies to.** `docker/base/init-firewall.sh`, every smoke test that starts a
container.
