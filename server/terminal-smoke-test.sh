#!/usr/bin/env bash
# Smoke test for the terminal bridge: checks the acceptance criteria from issue
# #4 against a real Docker daemon, a real container and a real WebSocket.
#
#   ./server/terminal-smoke-test.sh              # builds base image + server, then tests
#   SKIP_BUILD=1 ./server/terminal-smoke-test.sh # uses what is already built
#
# Requires: docker, node, pnpm, curl. No Claude token needed -- the checks talk
# to a shell in the tmux session, not to Claude.
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-lib.sh"

IMAGE="${IMAGE:-claudops-base:smoke}"
PORT="${PORT:-18090}"
BASE="http://127.0.0.1:$PORT"

SERVER_LOG="$WORK_DIR/server.log"
PROBE_OUT="$WORK_DIR/probe.out"
PROBE_ERR="$WORK_DIR/probe.err"
# Not docker/project: this script is about the console, and a real dotnet SDK
# would add minutes to it. The stub takes the same build args and installs
# nothing.
PROJECT_CONTEXT_NATIVE="$(native "$REPO_ROOT/docker/project-stub")"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-120}"

# A project's image is built asynchronously, and an instance cannot start before
# it is there.
wait_for_image() {
  local id="$1" _
  for _ in $(seq 1 "$BUILD_TIMEOUT"); do
    [[ "$(json image.status <<<"$(body_of GET "/projects/$id")")" == "ready" ]] && return 0
    sleep 1
  done
  return 1
}

trap smoke_cleanup EXIT

# The session cookie out of the jar wait_for_health filled, in the form a Cookie
# header takes. A browser sends this by itself; `ws` has to be told (#9).
session_cookie() {
  awk '$6 == "claudops_session" { printf "%s=%s", $6, $7 }' "$COOKIE_JAR" | tr -d '\r'
}

# probe <url> [steps...] -- terminal output lands in $PROBE_OUT, the close code
# and any control frame in $PROBE_ERR. Returns the probe's exit code.
#
# The URL stays first: ws-probe takes it positionally, so an option in front of
# it is read *as* the URL and the value behind it becomes an unknown step.
probe() {
  local url="$1"
  shift
  (cd "$SERVER_DIR" && pnpm exec tsx scripts/ws-probe.ts \
    "$url" --cookie "$(session_cookie)" "$@") >"$PROBE_OUT" 2>"$PROBE_ERR"
}

# probe_without_cookie <url> [steps...] -- the same, unauthenticated: the
# upgrade has to fail rather than hand out a console.
probe_without_cookie() {
  (cd "$SERVER_DIR" && pnpm exec tsx scripts/ws-probe.ts "$@") >"$PROBE_OUT" 2>"$PROBE_ERR"
}

screen() { cat "$PROBE_OUT"; }
diagnostics() { cat "$PROBE_ERR"; }
close_code() { sed -n 's/^\[close\] code=\([0-9]*\).*/\1/p' "$PROBE_ERR" | head -1; }

in_container() { docker exec "$container_id" "$@" 2>/dev/null | tr -d '\r'; }

# ----------------------------------------------------------------------- build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  build_base_image "$IMAGE" || { bad "docker build"; exit 1; }
  build_server || { bad "pnpm build"; exit 1; }
fi

# ---------------------------------------------------------------------- server
info "Starting server on port $PORT"
start_server "$PORT" "$WORK_DIR_NATIVE/claudops.db" "$SERVER_LOG" \
  "CLAUDOPS_BASE_IMAGE=$IMAGE" \
  "CLAUDOPS_PROJECT_CONTEXT=$PROJECT_CONTEXT_NATIVE"

if wait_for_health "$BASE"; then
  ok "Server is up and Docker is reachable"
else
  bad "Server did not become healthy -- log:"
  sed 's/^/        /' "$SERVER_LOG"
  exit 1
fi

# A project first: an instance is created from one, and this one deliberately
# has no PAT, so the console test needs no secret key either.
project_id="$(json id <<<"$(body_of POST /projects \
  '{"name":"terminal","repoUrl":"https://github.com/dominikz98/does-not-exist.git"}')")"
if [[ -z "$project_id" ]]; then
  bad "Could not create the project the instance needs"
  exit 1
fi
if ! wait_for_image "$project_id"; then
  bad "The project image never became ready"
  exit 1
fi

instance_json="$(body_of POST /instances "{\"name\":\"terminal\",\"projectId\":\"$project_id\"}")"
instance_id="$(json id <<<"$instance_json")"
container_id="$(json containerId <<<"$instance_json")"
if [[ -n "$instance_id" && -n "$container_id" ]]; then
  ok "Instance started ($instance_id)"
else
  bad "Could not create an instance: $instance_json"
  exit 1
fi

terminal_url="ws://127.0.0.1:$PORT/instances/$instance_id/terminal"

# The bridge attaches to the session the entrypoint starts, so wait for it.
for _ in $(seq 1 30); do
  docker exec "$container_id" tmux has-session -t main >/dev/null 2>&1 && break
  sleep 1
done
if docker exec "$container_id" tmux has-session -t main >/dev/null 2>&1; then
  ok "tmux session 'main' is up in the container"
else
  bad "tmux session never appeared -- docker logs:"
  docker logs "$container_id" 2>&1 | sed 's/^/        /'
  exit 1
fi

# Window 0 runs Claude, whose output depends on a token and on the day. A second
# window with a plain login shell makes every check below deterministic without
# touching the session the bridge is tested against.
docker exec "$container_id" tmux new-window -t main -n probe 'exec bash -l' >/dev/null 2>&1 \
  || { bad "could not open a probe window in the session"; exit 1; }

# ------------------------------------------------- AC 1: I/O in both directions
info "AC 1: terminal I/O works in both directions"
# `printf 'MARK-%s\n' ALPHA` is echoed as typed and answers 'MARK-ALPHA', so the
# needle can only come from the shell -- an echo of the keystrokes alone would
# not contain it.
probe "$terminal_url?cols=100&rows=30" --timeout 20000 \
  sleep:600 \
  'line:stty size' \
  'wait:30 100' \
  "textline:printf 'MARK-%s\n' ALPHA" \
  'wait:MARK-ALPHA' \
  'line:sleep 987 &' \
  'wait:[1]' \
  resize:120x40 \
  sleep:400 \
  'line:stty size' \
  'wait:40 120'
probe_status=$?

check "Probe ran every step" "0" "$probe_status"
contains "Output from the container reached the client" "MARK-ALPHA" "$(screen)"
contains "Keystrokes sent as a text frame are typed, so wscat works" "printf 'MARK-%s" "$(screen)"
contains "The command really ran in the container" "MARK-ALPHA" \
  "$(in_container tmux capture-pane -p -S - -t main:probe)"

# ------------------------------------------------------------- AC 3: resize
info "AC 3: resize takes effect inside the container"
# stty reports the pty of the process in the pane, so these two lines prove the
# geometry travelled bridge -> exec -> tmux client -> pane.
contains "Geometry from the connect URL arrives as 30x100" "30 100" "$(screen)"
contains "A resize message arrives as 40x120" "40 120" "$(screen)"
check "The pane kept the size of the last client" "120x40" \
  "$(in_container tmux display -p -t main:probe '#{pane_width}x#{pane_height}')"

# ----------------------------------- AC 2: reconnect keeps state and scrollback
info "AC 2: disconnect and reconnect leaves the session intact"
# The exec ends when the socket does, but Docker and tmux need a moment to
# notice; checking instantly would test the race rather than the teardown.
sleep 1
check "No client stayed attached after the socket closed" "" \
  "$(in_container tmux list-clients -t main)"

probe "$terminal_url?cols=120&rows=40" --timeout 20000 \
  'wait:MARK-ALPHA' \
  'line:jobs' \
  'wait:Running'
probe_status=$?

check "Reconnect ran every step" "0" "$probe_status"
contains "The redraw brought the earlier output back" "MARK-ALPHA" "$(screen)"
contains "The process started before the disconnect is still running" "sleep 987" "$(screen)"
contains "Scrollback is in the container, not in the server" "MARK-ALPHA" \
  "$(in_container tmux capture-pane -p -S - -t main:probe)"

# ------------------------------------------------------------ control messages
info "A broken control message is answered, not fatal"
probe "$terminal_url" --timeout 20000 \
  'text:{"type":"resize","cols":0,"rows":0}' \
  "line:printf 'AFTER-%s\n' BAD" \
  'wait:AFTER-BAD'
probe_status=$?

check "The console stayed usable" "0" "$probe_status"
contains "The server said what was wrong" "invalid_message" "$(diagnostics)"

# -------------------------------------------------------------------- refusals
info "Refusals carry a close code, not a hang"
probe "ws://127.0.0.1:$PORT/instances/does-not-exist/terminal" --timeout 5000
check "An unknown instance closes with 4404" "4404" "$(close_code)"

docker stop "$container_id" >/dev/null 2>&1
probe "$terminal_url" --timeout 5000
check "A stopped container closes with 4409" "4409" "$(close_code)"

# ------------------------------------------------------------------- AC (#9)
info "AC (#9): the WebSocket endpoint is unusable without a login"
probe_without_cookie "$terminal_url" --timeout 5000
probe_status=$?
# The gate answers the upgrade itself with a plain 401, so there is no socket and
# therefore no close code -- `ws` reports it as a failed handshake.
if [[ "$probe_status" != "0" ]]; then
  ok "An upgrade without a session cookie is refused (probe exit $probe_status)"
else
  bad "The terminal upgraded without a session cookie"
fi
contains "The refusal is an HTTP 401, before the handler runs" "401" "$(diagnostics)"

# --------------------------------------------------------------------- cleanup
info "The instance can still be deleted afterwards"
check "DELETE answers 204" "204" "$(status_of DELETE "/instances/$instance_id")"
check "No container left for the instance" "" "$(containers_for "$instance_id")"
check "And its project goes with it" "204" "$(status_of DELETE "/projects/$project_id")"

report
