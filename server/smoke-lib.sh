#!/usr/bin/env bash
# Shared plumbing for the claudops-server smoke tests. Sourced, never run:
#
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-lib.sh"
#
# What lives here is what is about the host rather than about a ticket: the two
# path worlds on the Windows dev host, building, starting a server and waiting
# for it to be healthy, reading JSON without jq, and counting results. The
# acceptance criteria stay in the script that owns them.

# Otherwise Git Bash/MSYS rewrites arguments that look like absolute paths and
# the docker checks would test nothing. No effect on Linux.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/.." && pwd)"

# Two path worlds on the Windows dev host: the scripts run in MSYS and see POSIX
# paths, while node.exe, curl.exe and docker.exe are native Windows programs --
# and MSYS_NO_PATHCONV above (needed for the docker arguments) turns the
# automatic conversion off. So keep a native form of every path handed to one of
# them. On Linux both are the same string.
native() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }

WORK_DIR="$(mktemp -d)"
WORK_DIR_NATIVE="$(native "$WORK_DIR")"

pass=0
fail=0
SERVER_PIDS=()

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
    bad "$1 (looked for '$2' in: '${3:0:400}')"
  fi
}

# Reading JSON with node rather than jq: node is a hard dependency of the
# server anyway, jq is not installed on every dev host.
json() { node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const value = process.argv[1]
        .split(".")
        .reduce((acc, key) => (acc == null ? acc : acc[key]), JSON.parse(raw));
      process.stdout.write(value === undefined || value === null ? "" : String(value));
    } catch {
      process.stdout.write("");
    }
  });
' "$1"; }

# api <method> <path> [body] -- prints "<status>\n<body>", against $BASE.
# Everything goes through stdout: handing curl.exe an -o path would need the
# native form.
api() {
  local method="$1" path="$2" body="${3:-}" raw
  if [[ -n "$body" ]]; then
    raw="$(curl -s -w '\n%{http_code}' \
      -X "$method" -H 'content-type: application/json' -d "$body" "$BASE$path")"
  else
    raw="$(curl -s -w '\n%{http_code}' -X "$method" "$BASE$path")"
  fi
  # Status last on the wire, first in the output -- so callers can read either
  # half without knowing how long the body is.
  printf '%s\n%s' "$(tail -n1 <<<"$raw")" "$(sed '$d' <<<"$raw")"
}

status_of() { api "$@" | head -1; }
body_of()   { api "$@" | tail -n +2; }

containers_for() {
  docker ps -a --filter "label=claudops.instance=$1" --format '{{.ID}}' | tr -d '\r'
}

volumes_for() {
  docker volume ls --filter "label=claudops.instance=$1" -q | tr -d '\r'
}

build_base_image() {
  local image="$1" context="$REPO_ROOT/docker/base"
  info "Building base image ($image)"
  command -v cygpath >/dev/null 2>&1 && context="$(cygpath -w "$context")"
  docker build -t "$image" "$context" >/dev/null
}

build_server() {
  info "Building server"
  (cd "$REPO_ROOT" && pnpm --filter @claudops/server build >/dev/null)
}

# start_server <port> <db-file-native> <log-file> [KEY=VALUE ...]
#
# Sets SERVER_PID and remembers it for the cleanup. Deliberately not printed for
# a `$(...)` to capture: command substitution runs in a subshell, where both the
# assignment and the bookkeeping would be thrown away -- and a server nobody
# kills holds its port against the next run.
start_server() {
  local port="$1" db="$2" log="$3"
  shift 3
  (
    cd "$SERVER_DIR" || exit 1
    export CLAUDOPS_HOST=127.0.0.1 CLAUDOPS_PORT="$port" CLAUDOPS_DB="$db"
    local assignment
    for assignment in "$@"; do export "${assignment?}"; done
    exec node dist/index.js
  ) >"$log" 2>&1 &
  SERVER_PID=$!
  SERVER_PIDS+=("$SERVER_PID")
}

# wait_for_health <base-url> [tries]
wait_for_health() {
  local base="$1" tries="${2:-30}" _
  for _ in $(seq 1 "$tries"); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/health")" == "200" ]] && return 0
    sleep 1
  done
  return 1
}

# Everything the run leaked, identified by the label that exists for exactly
# this purpose. Volumes as well as containers: a script that plays "somebody
# left a volume behind" has to be able to clean that up again.
remove_leftovers() {
  local leftovers
  leftovers="$(docker ps -aq --filter 'label=claudops.instance' | tr -d '\r')"
  [[ -n "$leftovers" ]] && docker rm -f $leftovers >/dev/null 2>&1
  leftovers="$(docker volume ls -q --filter 'label=claudops.instance' | tr -d '\r')"
  [[ -n "$leftovers" ]] && docker volume rm -f $leftovers >/dev/null 2>&1
  return 0
}

# stop_server <pid> <base-url> -- kills a server and waits for its port to go
# quiet, so the next one on the same port really binds.
stop_server() {
  local pid="$1" base="$2" _
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 15); do
    curl -s -o /dev/null --max-time 1 "$base/health" || return 0
    sleep 1
  done
  return 1
}

smoke_cleanup() {
  local pid
  # The :- keeps `set -u` from tripping over an array that stayed empty.
  for pid in "${SERVER_PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
  done
  remove_leftovers
  # A killed node process on Windows holds the SQLite file for a moment longer,
  # and rm would report it as busy and leave the temp directory behind.
  sleep 1
  rm -rf "$WORK_DIR"
  return 0
}

report() {
  info "Result: $pass passed, $fail failed"
  [[ "$fail" -eq 0 ]]
}
