# better-sqlite3 13 segfaults on Node below 22.14

**Fact.** The prebuilt binary in `better-sqlite3@13` needs Node-API 10, which
arrived in Node 22.14. On Node 22.13 `require('better-sqlite3')` does not throw
-- the process dies with a segmentation fault, and `pnpm test` reports a worker
that vanished. The package's own `engines` says `>=22`, so nothing warns.

**Why it matters here.** The server, its tests and every smoke test go through
that module, so on such a host the entire test gate is red for a reason that has
nothing to do with the change under test. `node -p "process.versions.napi"` has
to say `10` or more; anything less needs a newer Node before any result from this
repository means anything.

**A neighbouring trap on Windows.** `pnpm install` may still fail on that package
even though its prebuilt binary is right there in the tarball: pnpm ignores
`"gypfile": false` and tries `node-gyp rebuild`, which needs a Visual Studio
node-gyp recognises. `pnpm install --ignore-scripts` installs everything anyway
and the prebuild is used -- the module needs no build step of its own.

**Applies to.** `server/package.json`, `pnpm-workspace.yaml`,
[pnpm-blocks-native-build-scripts.md](pnpm-blocks-native-build-scripts.md).
