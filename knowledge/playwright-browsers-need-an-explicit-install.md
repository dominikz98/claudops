# Playwright's browser is a separate install step, not part of `pnpm install`

**Fact.** `pnpm install` does not download Chromium. It has to be fetched once
per machine:

```bash
pnpm --filter @claudops/e2e exec playwright install chromium
```

Without it every e2e test fails at launch with "Executable doesn't exist at ...".

**Why.** Playwright ships the browser through a postinstall script, and pnpm 10
blocks install scripts unless the package is listed in `onlyBuiltDependencies`
-- the same mechanism that already bites `better-sqlite3`
([pnpm-blocks-native-build-scripts.md](pnpm-blocks-native-build-scripts.md)).
Adding `playwright` to that list would work, but it would also pull ~115 MB on
every fresh install for everyone who never runs the browser tests, so the
explicit command was kept instead. `e2e/run.sh` prints it when the run fails.

**Applies to.** `e2e/`, `pnpm-workspace.yaml`. The e2e tests are deliberately not
a `test` script, so `pnpm test` stays fast and needs neither Docker nor a
browser.
