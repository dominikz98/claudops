#!/usr/bin/env bash
# Smoke test for claudops-server: checks the acceptance criteria from issue #3
# against a real Docker daemon and a real server process.
#
#   ./server/smoke-test.sh              # builds base image + server, then tests
#   SKIP_BUILD=1 ./server/smoke-test.sh # uses what is already built
#
# Requires: docker, node, curl. A CLAUDE_CODE_OAUTH_TOKEN is passed through if
# set, but is not required -- the container stays alive either way.
#
# The terminal bridge of issue #4 has its own script: ./server/terminal-smoke-test.sh
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-lib.sh"

IMAGE="${IMAGE:-claudops-base:smoke}"
PORT="${PORT:-18080}"
BASE="http://127.0.0.1:$PORT"

DB_FILE="$WORK_DIR/claudops.db"
DB_FILE_NATIVE="$WORK_DIR_NATIVE/claudops.db"
SERVER_LOG="$WORK_DIR/server.log"
GIT_TOKEN_PROBE="smoke-pat-must-not-appear"

trap smoke_cleanup EXIT

# ----------------------------------------------------------------------- build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  build_base_image "$IMAGE" || { bad "docker build"; exit 1; }
  build_server || { bad "pnpm build"; exit 1; }
fi

# ---------------------------------------------------------------------- server
info "Starting server on port $PORT"
start_server "$PORT" "$DB_FILE_NATIVE" "$SERVER_LOG" \
  "CLAUDOPS_BASE_IMAGE=$IMAGE" \
  'CLAUDOPS_GIT_USER_NAME=claudops' \
  'CLAUDOPS_GIT_USER_EMAIL=claudops@example.invalid'
server_pid="$SERVER_PID"

if wait_for_health "$BASE"; then
  ok "Server is up and Docker is reachable"
else
  bad "Server did not become healthy -- log:"
  sed 's/^/        /' "$SERVER_LOG"
  exit 1
fi

# ------------------------------------------- AC 1: POST starts a real container
info "AC 1: creating an instance via curl results in a running container"
created="$(api POST /instances "{\"name\":\"smoke\",\"gitToken\":\"$GIT_TOKEN_PROBE\"}")"
check "POST /instances answers 201" "201" "$(head -1 <<<"$created")"

instance_json="$(tail -n +2 <<<"$created")"
instance_id="$(json id <<<"$instance_json")"
container_id="$(json containerId <<<"$instance_json")"

if [[ -n "$instance_id" && -n "$container_id" ]]; then
  ok "Response carries an instance id and a container id"
else
  bad "No ids in the response: $instance_json"
  exit 1
fi

check "Container is running in docker ps" "true" \
  "$(docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null | tr -d '\r')"
check "Container carries claudops.instance=<id>" "$instance_id" \
  "$(docker inspect -f "{{index .Config.Labels \"claudops.instance\"}}" "$container_id" 2>/dev/null | tr -d '\r')"
check "Container is named after the instance" "/claudops-$instance_id" \
  "$(docker inspect -f '{{.Name}}' "$container_id" 2>/dev/null | tr -d '\r')"
check "Container runs the configured base image" "$IMAGE" \
  "$(docker inspect -f '{{.Config.Image}}' "$container_id" 2>/dev/null | tr -d '\r')"

info "The git token reaches the container but nothing else"
if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null \
   | grep -q "^GIT_TOKEN=$GIT_TOKEN_PROBE$"; then
  ok "GIT_TOKEN is in the container environment"
else
  bad "GIT_TOKEN did not reach the container"
fi
check "No ANTHROPIC_API_KEY next to the OAuth token" "0" \
  "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null \
     | grep -c '^ANTHROPIC_API_KEY=' | tr -d '\r')"
check "Token is not echoed back by the API" "0" \
  "$(grep -c "$GIT_TOKEN_PROBE" <<<"$instance_json")"
# grep -c prints its 0 and still exits 1, so only the exit code is swallowed --
# an empty result would mean the database file was not found at all, which has
# to fail rather than look like "no token in there".
check "Token is not in the database" "0" \
  "$(grep -ac "$GIT_TOKEN_PROBE" "$DB_FILE" 2>/dev/null || true)"
check "Token is not in the server log" "0" \
  "$(grep -c "$GIT_TOKEN_PROBE" "$SERVER_LOG" | tr -d '\r')"

# -------------------------------------- AC 3: the list reports the Docker state
info "AC 3: the list shows the status taken from the Docker API"
list="$(body_of GET /instances)"
check "Instance is listed as running" "running" "$(json instances.0.status <<<"$list")"
check "Listed instance is the one created" "$instance_id" "$(json instances.0.id <<<"$list")"

docker stop "$container_id" >/dev/null 2>&1
check "Status follows the container into exited" "exited" \
  "$(json instances.0.status <<<"$(body_of GET /instances)")"
check "Single instance reports it too" "exited" \
  "$(json status <<<"$(body_of GET "/instances/$instance_id")")"

# ------------------------------------------- AC 2: DELETE removes the container
info "AC 2: DELETE removes the container"
check "DELETE answers 204" "204" "$(status_of DELETE "/instances/$instance_id")"
check "No container left for the instance" "" "$(containers_for "$instance_id")"
check "Instance is gone from the list" "" \
  "$(json instances.0.id <<<"$(body_of GET /instances)")"
check "GET on the deleted instance answers 404" "404" \
  "$(status_of GET "/instances/$instance_id")"
check "A second DELETE answers 404" "404" \
  "$(status_of DELETE "/instances/$instance_id")"

# -------------------------------------------------------------- error behaviour
info "Error behaviour"
check "POST without a name answers 400" "400" "$(status_of POST /instances '{}')"
check "POST with an unknown field answers 400" "400" \
  "$(status_of POST /instances '{"name":"x","env":{"ANTHROPIC_API_KEY":"nope"}}')"
check "GET on an unknown id answers 404" "404" "$(status_of GET /instances/does-not-exist)"

# A second server, pointed at an image that does not exist, is the only way to
# see the real Docker 404 -- the unit tests can only fake it.
info "A missing base image is reported as 422, not swallowed"
second_port=$((PORT + 1))
second_base="http://127.0.0.1:$second_port"
start_server "$second_port" "$WORK_DIR_NATIVE/no-image.db" "$WORK_DIR/no-image.log" \
  'CLAUDOPS_BASE_IMAGE=claudops-does-not-exist:0'
wait_for_health "$second_base"

check "POST against a missing image answers 422" "422" \
  "$(curl -s -o "$WORK_DIR/no-image-body" -w '%{http_code}' \
      -X POST -H 'content-type: application/json' -d '{"name":"no-image"}' \
      "$second_base/instances")"
check "No instance was recorded for the failed create" "" \
  "$(curl -s "$second_base/instances" | json instances.0.id)"

check "Server survived the whole run" "0" "$(kill -0 "$server_pid" 2>/dev/null; echo $?)"

report
