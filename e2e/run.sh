#!/usr/bin/env bash
# End-to-end tests for the web UI: the browser-interactive acceptance criteria
# -- issue #5 and every ticket since whose claim is about what a person sees --
# against a real server, a real Docker daemon and a real container.
#
#   ./e2e/run.sh                # builds base image, server and UI, then tests
#   SKIP_BUILD=1 ./e2e/run.sh   # uses what is already built
#
# Requires: docker, node, pnpm, and Chromium for Playwright -- pnpm 10 does not
# download it at install time, so it is a separate one-off command
# (knowledge/playwright-browsers-need-an-explicit-install.md).
#
# Like the other smoke tests here, this removes every container carrying the
# claudops label when it exits.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$E2E_DIR/../server/smoke-lib.sh"

IMAGE="${IMAGE:-claudops-base:e2e}"
export CLAUDOPS_E2E_IMAGE="$IMAGE"
# A fresh key per run: the projects created here store a PAT, and nothing needs
# to read them again afterwards.
export CLAUDOPS_E2E_SECRET_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
# Same reasoning for the login (#9): the server refuses to start without one, and
# nothing outlives this run that would need it again.
export CLAUDOPS_E2E_LOGIN_SECRET="e2e-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"

trap smoke_cleanup EXIT

# ----------------------------------------------------------------------- build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  build_base_image "$IMAGE" || { bad "docker build"; exit 1; }
  build_server || { bad "pnpm build (server)"; exit 1; }
  info "Building web UI"
  (cd "$REPO_ROOT" && pnpm --filter @claudops/web build >/dev/null) \
    || { bad "pnpm build (web)"; exit 1; }
fi

# The first assertion is that the list starts empty, so the database from the
# last run has to go. Playwright creates it again under e2e/.tmp.
rm -rf "$E2E_DIR/.tmp"

# ------------------------------------------------------------------------ test
info "Running the browser tests"
(cd "$E2E_DIR" && pnpm exec playwright test "$@")
status=$?

if [[ $status -ne 0 ]]; then
  printf '\n%s\n  %s\n' \
    'If Playwright reported a missing browser, install it once with:' \
    'pnpm --filter @claudops/e2e exec playwright install chromium'
fi

exit $status
