# The status port is the one hole in the egress firewall, and it is a port

**Fact.** The claudops server listens twice: `CLAUDOPS_PORT` (8080) carries the
API, the login and the SPA, and `CLAUDOPS_STATUS_PORT` (8081) carries exactly one
route, `POST /instances/:id/status`. `init-firewall.sh` adds a single rule --
`-d <bridge gateway> -p tcp --dport <status port> -j ACCEPT` -- and the container
reaches nothing else on the host.

**Why two listeners.** The container's egress firewall filters by address and
port; it cannot filter by path. Putting the status route on the API's port would
have meant opening that port, and with it `POST /login` as a brute-force target
against the shared secret, plus the SPA and every endpoint added later -- for a
container whose whole premise is "reaches whitelisted domains and no others".
A second Fastify app is perhaps sixty lines and makes the hole exactly one route
wide, which is a thing that can be read and checked rather than trusted.

**Why a rule and not an ipset entry.** The whitelist set matches a destination
*address*, and the API is on the same address as the status listener -- only the
port separates them. An entry in the set would open both.

**Why the container works the address out itself.** The server does not know it:
it is the gateway of whichever bridge the container ends up on, visible only from
inside. `claudops-status` and `init-firewall.sh` each read it from
`/proc/net/route` (little-endian hex, and there is no iproute2 in the image).
Duplicated on purpose -- one runs as the agent, the other as root from a 0500
file the agent cannot read.

**What the token is and is not.** `CLAUDOPS_STATUS_TOKEN` is an HMAC over the
instance id, derived from `CLAUDOPS_LOGIN_SECRET`, so nothing is stored. It stops
one instance from reporting another's status and everything else on the LAN from
reporting any. It does not stop the agent from lying about *itself* -- it can
read its own environment, and it can edit its own hooks. The badge says what the
instance claims it is doing, which is the question the operator is asking.

Rotating `CLAUDOPS_LOGIN_SECRET` invalidates the tokens of containers that are
already running: they keep reporting with the old one and the server logs
`status report with no valid token` until they are restarted.

**Applies to.** `docker/base/init-firewall.sh`, `docker/base/claudops-status`,
`server/src/status/`, `server/src/config.ts`, `docker/base/smoke-test.sh`,
issue #17. Supersedes half of
[Do not whitelist the docker bridge](do-not-whitelist-the-docker-bridge.md),
which is still right about everything except this one port.
