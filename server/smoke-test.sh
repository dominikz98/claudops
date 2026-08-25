#!/usr/bin/env bash
# Smoke test for claudops-server: checks the acceptance criteria from issues #3
# and #6 against a real Docker daemon and a real server process.
#
#   ./server/smoke-test.sh              # builds base image + server, then tests
#   SKIP_BUILD=1 ./server/smoke-test.sh # uses what is already built
#
# Requires: docker, node, curl, and network access -- one instance really clones
# the public claudops repository. A CLAUDE_CODE_OAUTH_TOKEN is passed through if
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
PUBLIC_REPO="https://github.com/dominikz98/claudops.git"
# Hex rather than base64: it survives every layer of quoting between here and
# the server's environment without a thought.
SECRET_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

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
  "CLAUDOPS_SECRET_KEY=$SECRET_KEY" \
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

# ------------------------------------------------ #6: a project holds the PAT
info "#6: creating a project with a PAT"
created="$(api POST /projects "{\"name\":\"smoke\",\"repoUrl\":\"https://github.com/dominikz98/does-not-exist.git\",\"repoBranch\":\"main\",\"gitToken\":\"$GIT_TOKEN_PROBE\",\"buildingBlocks\":{\"dotnet\":true,\"playwright\":false}}")"
check "POST /projects answers 201" "201" "$(head -1 <<<"$created")"

project_json="$(tail -n +2 <<<"$created")"
project_id="$(json id <<<"$project_json")"

if [[ -n "$project_id" ]]; then
  ok "Response carries a project id"
else
  bad "No project id in the response: $project_json"
  exit 1
fi

check "Project reports a stored token without returning it" "true" \
  "$(json hasGitToken <<<"$project_json")"
check "The PAT itself is not in the response" "0" "$(grep -c "$GIT_TOKEN_PROBE" <<<"$project_json")"
check "Building blocks come back as they went in" "true" \
  "$(json buildingBlocks.dotnet <<<"$project_json")"
check "A fresh project has no instances" "0" "$(json instanceCount <<<"$project_json")"
check "The project is listed" "$project_id" \
  "$(json projects.0.id <<<"$(body_of GET /projects)")"

# The database is in WAL mode, so a freshly written row lives in the -wal file
# and not yet in the .db -- grepping only the latter would find nothing and look
# like proof. Both files together are what "on disk" means here.
db_bytes() { cat "$DB_FILE" "$DB_FILE-wal" 2>/dev/null; }

# grep -c prints its 0 and still exits 1, so only the exit code is swallowed.
check "The PAT is not readable on disk" "0" \
  "$(db_bytes | grep -ac "$GIT_TOKEN_PROBE" || true)"
if db_bytes | grep -aq 'v1:'; then
  ok "What is on disk is the sealed form"
else
  bad "No sealed token on disk -- was it stored at all?"
fi
check "The PAT is not in the server log" "0" \
  "$(grep -c "$GIT_TOKEN_PROBE" "$SERVER_LOG" | tr -d '\r')"

# ------------------------------------------- AC 1: POST starts a real container
info "AC 1: creating an instance from the project results in a running container"
created="$(api POST /instances "{\"name\":\"smoke\",\"projectId\":\"$project_id\"}")"
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
check "Instance points back at its project" "$project_id" "$(json projectId <<<"$instance_json")"
check "Instance snapshots the branch of the project" "main" \
  "$(json repoBranch <<<"$instance_json")"
check "The project now counts one instance" "1" \
  "$(json projects.0.instanceCount <<<"$(body_of GET /projects)")"

info "The project's repository and PAT reach the container, nothing else does"
container_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null; }

if container_env "$container_id" | grep -q "^GIT_TOKEN=$GIT_TOKEN_PROBE$"; then
  ok "GIT_TOKEN is the decrypted PAT of the project"
else
  bad "GIT_TOKEN did not reach the container"
fi
if container_env "$container_id" | grep -q '^REPO_BRANCH=main$'; then
  ok "REPO_BRANCH comes from the project"
else
  bad "REPO_BRANCH did not reach the container"
fi
check "No ANTHROPIC_API_KEY next to the OAuth token" "0" \
  "$(container_env "$container_id" | grep -c '^ANTHROPIC_API_KEY=' | tr -d '\r')"
check "Token is not echoed back by the API" "0" \
  "$(grep -c "$GIT_TOKEN_PROBE" <<<"$instance_json")"
check "Token still not readable on disk" "0" \
  "$(db_bytes | grep -ac "$GIT_TOKEN_PROBE" || true)"
check "Token still not in the server log" "0" \
  "$(grep -c "$GIT_TOKEN_PROBE" "$SERVER_LOG" | tr -d '\r')"

# ------------------------------------ AC 1 continued: the clone really happens
# A second project, without a PAT: the public repository refuses invalid
# credentials, so the token probe above and a real clone cannot be the same
# instance.
info "AC 1: an instance of a public project clones the configured repo and branch"
clone_project="$(json id <<<"$(body_of POST /projects \
  "{\"name\":\"smoke-public\",\"repoUrl\":\"$PUBLIC_REPO\",\"repoBranch\":\"main\"}")")"
clone_instance="$(body_of POST /instances "{\"name\":\"smoke-clone\",\"projectId\":\"$clone_project\"}")"
clone_id="$(json id <<<"$clone_instance")"
clone_container="$(json containerId <<<"$clone_instance")"

cloned=""
for _ in $(seq 1 60); do
  if docker exec "$clone_container" test -d /workspace/claudops/.git 2>/dev/null; then
    cloned="yes"
    break
  fi
  sleep 2
done
check "The repository is cloned into /workspace/claudops" "yes" "$cloned"
check "The checked out branch is the one the project names" "main" \
  "$(docker exec "$clone_container" git -C /workspace/claudops rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\r')"
check "No token ends up in the remote URL" "0" \
  "$(docker exec "$clone_container" git -C /workspace/claudops remote get-url origin 2>/dev/null | grep -c '@')"

check "DELETE of the clone instance answers 204" "204" "$(status_of DELETE "/instances/$clone_id")"
check "DELETE of the clone project answers 204" "204" "$(status_of DELETE "/projects/$clone_project")"

# --------------------------------------- AC 3: the list reports the Docker state
info "AC 3: the list shows the status taken from the Docker API"
list="$(body_of GET /instances)"
check "Instance is listed as running" "running" "$(json instances.0.status <<<"$list")"
check "Listed instance is the one created" "$instance_id" "$(json instances.0.id <<<"$list")"

docker stop "$container_id" >/dev/null 2>&1
check "Status follows the container into exited" "exited" \
  "$(json instances.0.status <<<"$(body_of GET /instances)")"
check "Single instance reports it too" "exited" \
  "$(json status <<<"$(body_of GET "/instances/$instance_id")")"

# --------------------------- #6: a project in use cannot be deleted by accident
info "#6: a project keeps its instances -- even stopped ones"
refused="$(api DELETE "/projects/$project_id")"
check "DELETE /projects answers 409 while an instance exists" "409" "$(head -1 <<<"$refused")"
check "The conflict is named" "project_in_use" "$(json error <<<"$(tail -n +2 <<<"$refused")")"
contains "The message says how many instances are in the way" "1 instance" \
  "$(json message <<<"$(tail -n +2 <<<"$refused")")"

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

info "#6: with its instances gone, the project can be deleted"
check "DELETE /projects answers 204" "204" "$(status_of DELETE "/projects/$project_id")"
check "Project is gone from the list" "" \
  "$(json projects.0.id <<<"$(body_of GET /projects)")"
check "A second DELETE answers 404" "404" "$(status_of DELETE "/projects/$project_id")"

# -------------------------------------------------------------- error behaviour
info "Error behaviour"
check "POST /instances without a name answers 400" "400" \
  "$(status_of POST /instances '{"projectId":"whatever"}')"
check "POST /instances without a project answers 400" "400" \
  "$(status_of POST /instances '{"name":"x"}')"
check "POST /instances with the old repository fields answers 400" "400" \
  "$(status_of POST /instances '{"name":"x","projectId":"y","repoUrl":"https://host/r.git"}')"
check "POST /instances with an unknown project answers 422" "422" \
  "$(status_of POST /instances '{"name":"x","projectId":"does-not-exist"}')"
check "POST /projects without a repository answers 400" "400" \
  "$(status_of POST /projects '{"name":"x"}')"
check "POST /projects with an unknown field answers 400" "400" \
  "$(status_of POST /projects '{"name":"x","repoUrl":"https://host/r.git","env":{}}')"
check "GET on an unknown instance answers 404" "404" "$(status_of GET /instances/does-not-exist)"
check "GET on an unknown project answers 404" "404" "$(status_of GET /projects/does-not-exist)"

info "A duplicate project name answers 409"
duplicate='{"name":"twice","repoUrl":"https://host/r.git"}'
check "First one is created" "201" "$(status_of POST /projects "$duplicate")"
check "Second one is a conflict" "409" "$(status_of POST /projects "$duplicate")"

# A second server, without an image and without a secret key, is the only way to
# see both a real Docker 404 and the keyless behaviour -- the unit tests can only
# fake them.
info "A missing base image is reported as 422, and a missing key refuses the PAT"
second_port=$((PORT + 1))
second_base="http://127.0.0.1:$second_port"
start_server "$second_port" "$WORK_DIR_NATIVE/no-image.db" "$WORK_DIR/no-image.log" \
  'CLAUDOPS_BASE_IMAGE=claudops-does-not-exist:0'
wait_for_health "$second_base"

BASE="$second_base"
keyless="$(api POST /projects '{"name":"needs-a-key","repoUrl":"https://host/r.git","gitToken":"nope"}')"
check "POST /projects with a PAT and no key answers 422" "422" "$(head -1 <<<"$keyless")"
check "The refusal names the missing key" "secret_key_missing" \
  "$(json error <<<"$(tail -n +2 <<<"$keyless")")"
check "A project without a PAT is still created" "201" \
  "$(status_of POST /projects '{"name":"public-only","repoUrl":"https://host/r.git"}')"

no_image_project="$(json id <<<"$(body_of POST /projects \
  '{"name":"no-image","repoUrl":"https://host/r.git"}')")"
check "POST against a missing image answers 422" "422" \
  "$(status_of POST /instances "{\"name\":\"no-image\",\"projectId\":\"$no_image_project\"}")"
check "No instance was recorded for the failed create" "" \
  "$(json instances.0.id <<<"$(body_of GET /instances)")"
BASE="http://127.0.0.1:$PORT"

check "Server survived the whole run" "0" "$(kill -0 "$server_pid" 2>/dev/null; echo $?)"

report
