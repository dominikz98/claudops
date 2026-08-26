#!/usr/bin/env bash
# Smoke test for the project image template: checks the acceptance criteria from
# issue #7 against a genuinely built image and a running container.
#
#   ./docker/project/smoke-test.sh              # builds claudops-base first
#   SKIP_BASE=1 ./docker/project/smoke-test.sh  # reuses the base image
#
# This one is slow on the first run: a dotnet SDK and a Chromium are a few
# hundred megabytes. The second build is the point of AC 2 and takes seconds.
set -uo pipefail

# Otherwise Git Bash/MSYS rewrites arguments like "/ms-playwright" into Windows
# paths and the container checks would test nothing. No effect on Linux.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BASE_IMAGE="${BASE_IMAGE:-claudops-base:test}"
IMAGE="${IMAGE:-claudops-project:test}"
CONTAINER="${CONTAINER:-claudops-project-smoke}"
DOTNET_CHANNEL="${DOTNET_CHANNEL:-10.0}"
# How long an unchanged rebuild may take to still count as cached.
CACHE_BUDGET="${CACHE_BUDGET:-30}"

pass=0
fail=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# check <description> <expected> <actual>
check() {
  if [[ "$2" == "$3" ]]; then
    ok "$1"
  else
    bad "$1 (expected: '$2', actual: '$3')"
  fi
}

# contains <description> <needle> <haystack>
contains() {
  if [[ "$3" == *"$2"* ]]; then
    ok "$1"
  else
    bad "$1 (looked for '$2' in: '${3:0:300}')"
  fi
}

dexec() { docker exec "$CONTAINER" "$@"; }
native() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

# build_project <description> -- builds the template with both blocks on and
# prints how many seconds it took.
build_project() {
  local started elapsed
  started=$(date +%s)
  docker build -t "$IMAGE" \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --build-arg WITH_DOTNET=1 \
    --build-arg WITH_PLAYWRIGHT=1 \
    --build-arg "DOTNET_CHANNEL=$DOTNET_CHANNEL" \
    "$(native "$SCRIPT_DIR")" >"$1" 2>&1
  local status=$?
  elapsed=$(( $(date +%s) - started ))
  printf '%s' "$elapsed"
  return $status
}

# ------------------------------------------------------------------------ build
if [[ -z "${SKIP_BASE:-}" ]]; then
  info "Building the base image ($BASE_IMAGE)"
  docker build -t "$BASE_IMAGE" "$(native "$REPO_ROOT/docker/base")" >/dev/null \
    || { bad "docker build (base)"; exit 1; }
fi

info "Building the project image ($IMAGE) with dotnet + Playwright"
first_log="$(mktemp)"
first="$(build_project "$first_log")" || {
  bad "docker build (project) -- last lines:"
  tail -20 "$first_log" | sed 's/^/        /'
  exit 1
}
ok "First build finished in ${first}s"

# ------------------------------------------------------------- AC 2: the cache
info "AC 2: an unchanged rebuild comes off the layer cache"
second_log="$(mktemp)"
second="$(build_project "$second_log")" || { bad "docker build (rebuild)"; exit 1; }
if [[ "$second" -le "$CACHE_BUDGET" ]]; then
  ok "Rebuild finished in ${second}s (budget ${CACHE_BUDGET}s)"
else
  bad "Rebuild took ${second}s, more than the ${CACHE_BUDGET}s budget -- cache missed"
fi
contains "Rebuild reported cached layers" "CACHED" "$(cat "$second_log")$(cat "$first_log")"
rm -f "$first_log" "$second_log"

# --------------------------------------------------------- AC 1: the toolchain
info "Starting a container off the project image"
cleanup
# No REPO_URL: the clone is claudops-base's business and tested there. The tmux
# session still has to come up, because the entrypoint is inherited.
#
# NET_ADMIN for the same reason the server grants it: without it the inherited
# entrypoint seals the container off and withholds Claude, so this run would stop
# resembling production. The firewall itself is tested in docker/base.
docker run -d --name "$CONTAINER" --cap-add=NET_ADMIN "$IMAGE" >/dev/null \
  || { bad "docker run"; exit 1; }

for _ in $(seq 1 60); do
  dexec tmux has-session -t main >/dev/null 2>&1 && break
  sleep 1
done
check "The inherited entrypoint still starts the tmux session" "0" \
  "$(dexec tmux has-session -t main >/dev/null 2>&1; echo $?)"
check "Still runs as the unprivileged user" "claude" "$(dexec id -un 2>/dev/null | tr -d '\r')"

info "AC 1: dotnet works in the container"
dotnet_version="$(dexec dotnet --version 2>&1 | tr -d '\r')"
if [[ "$dotnet_version" == "$DOTNET_CHANNEL".* ]]; then
  ok "dotnet --version reports $dotnet_version"
else
  bad "dotnet --version reported '$dotnet_version', expected a $DOTNET_CHANNEL.x"
fi
check "The dotnet block added its nuget hosts to the egress whitelist" "0" \
  "$(dexec grep -q 'api\.nuget\.org' /etc/claudops/firewall-allow.d/10-dotnet.conf >/dev/null 2>&1; echo $?)"
check "DOTNET_ROOT is set in the image" "/usr/share/dotnet" \
  "$(dexec printenv DOTNET_ROOT 2>/dev/null | tr -d '\r')"

info "AC 1: a Playwright browser launches in the container"
# The browsers were installed by root, so the check that matters is that the
# unprivileged user can read them at all.
check "The browser directory is readable for the user" "0" \
  "$(dexec sh -c 'ls "$PLAYWRIGHT_BROWSERS_PATH" >/dev/null 2>&1; echo $?' | tr -d '\r')"

# --no-sandbox because Chromium's own sandbox needs privileges a claudops
# container deliberately does not have.
launch="$(dexec node -e '
  const { chromium } = require("playwright");
  chromium
    .launch({ args: ["--no-sandbox"] })
    .then(async (browser) => {
      process.stdout.write(browser.version());
      await browser.close();
    })
    .catch((error) => {
      process.stdout.write(`FAILED: ${error.message}`);
      process.exit(1);
    });
' 2>&1 | tr -d '\r')"
if [[ "$launch" == FAILED:* || -z "$launch" ]]; then
  bad "Chromium did not launch ($launch)"
else
  ok "Chromium launched and reported version $launch"
fi

info "Clean stop"
docker stop "$CONTAINER" >/dev/null 2>&1
ok "Container stopped"

info "Result: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
