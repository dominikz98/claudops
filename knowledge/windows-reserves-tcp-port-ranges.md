# A free port on Windows can still be a forbidden one

**Fact.** `./server/smoke-test.sh` binds 18080 and `./e2e/run.sh` binds 18091. On
a Windows dev host with Hyper-V or WSL2 both can land inside a reserved range and
the server dies with `listen EACCES: permission denied 127.0.0.1:18080` -- with
nothing listening on that port.

**Why.** Windows hands whole TCP ranges to Hyper-V for dynamic port forwarding,
and they move between boots. `netsh interface ipv4 show excludedportrange
protocol=tcp` lists them. EACCES rather than EADDRINUSE is the tell: the port is
not taken, it is not ours to take.

Both scripts take the port from the environment, so the way out is a port outside
the ranges rather than a change to the script:

```bash
PORT=19080 ./server/smoke-test.sh
CLAUDOPS_E2E_PORT=19091 ./e2e/run.sh
```

**Applies to.** `server/smoke-test.sh`, `e2e/playwright.config.ts`,
[windows-dev-host-linux-target.md](windows-dev-host-linux-target.md).
