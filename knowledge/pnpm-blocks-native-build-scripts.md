# pnpm 10 blocks install scripts, which native modules need

**Fact.** `pnpm-workspace.yaml` carries an `onlyBuiltDependencies` list with
`better-sqlite3` and `esbuild`. Without it pnpm 10 skips their install scripts
and prints "Ignored build scripts" as a warning, not an error.

**Why.** pnpm 10 stopped running install scripts by default. `better-sqlite3` is
a native module and `esbuild` (through vitest) unpacks a platform binary in its
postinstall, so both are unusable until they are allow-listed -- and the failure
surfaces much later, at require time, far from the warning that explained it.
The list stays explicit rather than blanket-enabled: `dockerode` pulls in `ssh2`
and `cpu-features` for an SSH transport claudops does not use, and those have no
business compiling anything on the NUC.

**Applies to.** `pnpm-workspace.yaml`, `server/package.json`, issue #3.
