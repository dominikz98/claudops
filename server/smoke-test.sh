#!/usr/bin/env bash
# Smoke test for claudops-server: checks the acceptance criteria from issues #3,
# #6, #7 and #8 against a real Docker daemon and a real server process. #8 needs
# two server processes on the same database -- the startup reconcile is only
# observable across a restart.
#
#   ./server/smoke-test.sh              # builds base image + server, then tests
#   SKIP_BUILD=1 ./server/smoke-test.sh # uses what is already built
#   FULL_IMAGE=1 ./server/smoke-test.sh # builds the real docker/project template
#
# Project images are built from docker/project-stub by default: this script is
# about the server, and a real dotnet SDK would add minutes to every run without
# telling it anything new. FULL_IMAGE=1 points it at docker/project instead,
# which is what proves the toolchain arrives in an actual instance.
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

if [[ -n "${FULL_IMAGE:-}" ]]; then
  PROJECT_CONTEXT="$REPO_ROOT/docker/project"
else
  PROJECT_CONTEXT="$REPO_ROOT/docker/project-stub"
fi
PROJECT_CONTEXT_NATIVE="$(native "$PROJECT_CONTEXT")"
# How long an image build may take before the test gives up on it.
BUILD_TIMEOUT="${BUILD_TIMEOUT:-$([[ -n "${FULL_IMAGE:-}" ]] && echo 900 || echo 120)}"

# wait_for_image <project-id> <wanted-status> -- polls until the build settles.
# Builds are asynchronous by design: POST /projects answers `pending` and the
# image appears later, so everything after a create has to wait here.
wait_for_image() {
  local id="$1" wanted="$2" seen _
  for _ in $(seq 1 "$BUILD_TIMEOUT"); do
    seen="$(json image.status <<<"$(body_of GET "/projects/$id")")"
    [[ "$seen" == "$wanted" ]] && return 0
    sleep 1
  done
  printf 'last seen: %s\n' "${seen:-<none>}" >&2
  return 1
}

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
  "CLAUDOPS_PROJECT_CONTEXT=$PROJECT_CONTEXT_NATIVE" \
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

# ------------------------------------------ #7: the project gets its own image
info "#7: the project's image is built and reported"
check "A fresh project reports an image that is not built yet" "pending" \
  "$(json image.status <<<"$project_json")"
check "The tag is derived from the project id" "claudops-project-$project_id" \
  "$(json image.tag <<<"$project_json")"
# Whether this POST is early enough is a race: the stub context builds inside a
# second, and on a fast host the image is ready before the request goes out. So
# the assertion is on the pair -- refused while the image is not there, accepted
# once it is -- and an instance that did slip through is removed again, because
# every count below assumes it does not exist. The refusal itself is checked
# without a race further down, against a project whose build really failed.
too_early="$(api POST /instances "{\"name\":\"too-early\",\"projectId\":\"$project_id\"}")"
if [[ "$(head -1 <<<"$too_early")" == "201" ]]; then
  ok "The image was already built and the create was accepted"
  status_of DELETE "/instances/$(json id <<<"$(tail -n +2 <<<"$too_early")")" >/dev/null
else
  check "Instance creation is refused until the image exists" "422" "$(head -1 <<<"$too_early")"
fi

if wait_for_image "$project_id" ready; then
  ok "The image became ready"
else
  bad "The image never became ready -- build log:"
  json log <<<"$(body_of GET "/projects/$project_id/build-log")" | tail -20 | sed 's/^/        /'
  exit 1
fi

project_json="$(body_of GET "/projects/$project_id")"
check "builtAt is recorded" "0" "$([[ -n "$(json image.builtAt <<<"$project_json")" ]]; echo $?)"
check "Docker has the tagged image" "1" \
  "$(docker images -q "claudops-project-$project_id" | grep -c . | tr -d '\r')"
check "The image carries the project label" "$project_id" \
  "$(docker inspect -f '{{index .Config.Labels "claudops.project"}}' \
      "claudops-project-$project_id" 2>/dev/null | tr -d '\r')"

build_log="$(json log <<<"$(body_of GET "/projects/$project_id/build-log")")"
contains "The build log was kept" "FROM" "$build_log"
check "The log is not carried in the project itself" "0" \
  "$(grep -c 'FROM' <<<"$project_json" | tr -d '\r')"

info "#7: a rebuild without changes comes off the layer cache"
rebuild_started=$(date +%s)
check "POST /projects/:id/build answers 202" "202" "$(status_of POST "/projects/$project_id/build")"
if wait_for_image "$project_id" ready; then
  rebuild_took=$(( $(date +%s) - rebuild_started ))
  if [[ "$rebuild_took" -le 60 ]]; then
    ok "Rebuild finished in ${rebuild_took}s"
  else
    bad "Rebuild took ${rebuild_took}s -- the layer cache was missed"
  fi
else
  bad "The rebuild never finished"
fi

info "#7: a PATCH that leaves the environment alone does not rebuild"
before="$(json image.builtAt <<<"$(body_of GET "/projects/$project_id")")"
check "PATCH of the name answers 200" "200" \
  "$(status_of PATCH "/projects/$project_id" '{"name":"smoke-renamed"}')"
check "The image stayed ready" "ready" \
  "$(json image.status <<<"$(body_of GET "/projects/$project_id")")"
check "It was not rebuilt" "$before" \
  "$(json image.builtAt <<<"$(body_of GET "/projects/$project_id")")"

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
check "Container runs the project image, not the base one" "claudops-project-$project_id" \
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


info "#7 AC 1: the environment of the project is inside the instance"
if [[ -n "${FULL_IMAGE:-}" ]]; then
  # The real template: the dotnet block was ticked on this project, so the SDK
  # has to answer inside the running instance.
  dotnet_in_instance="$(docker exec "$container_id" dotnet --version 2>&1 | tr -d '\r')"
  if [[ "$dotnet_in_instance" == [0-9]* ]]; then
    ok "dotnet --version in the instance reports $dotnet_in_instance"
  else
    bad "dotnet is not usable in the instance ($dotnet_in_instance)"
  fi
else
  # The stub writes the args it was built with, which is what proves the
  # building blocks of the project reached the build at all.
  check "The building blocks reached the build as args" "dotnet=1 playwright=0 channel=10.0" \
    "$(docker exec "$container_id" cat /tmp/claudops-blocks 2>/dev/null | tr -d '\r')"
  printf '  %s\n' "(FULL_IMAGE=1 checks a real dotnet SDK in the instance instead)"
fi

# ------------------------------------ AC 1 continued: the clone really happens
# A second project, without a PAT: the public repository refuses invalid
# credentials, so the token probe above and a real clone cannot be the same
# instance.
info "AC 1: an instance of a public project clones the configured repo and branch"
clone_project="$(json id <<<"$(body_of POST /projects \
  "{\"name\":\"smoke-public\",\"repoUrl\":\"$PUBLIC_REPO\",\"repoBranch\":\"main\"}")")"
# Its image first: a project has none until the build has run, and every
# instance starts from one.
if ! wait_for_image "$clone_project" ready; then
  bad "The image of the public project never became ready"
fi
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

# ------------------------------------------- #8: limits, stop/start, recycling
info "#8 AC 3: an instance is created with a CPU and memory ceiling"
lifecycle_json="$(body_of POST /instances "{\"name\":\"smoke-lifecycle\",\"projectId\":\"$project_id\"}")"
life_id="$(json id <<<"$lifecycle_json")"
life_container="$(json containerId <<<"$lifecycle_json")"

if [[ -z "$life_id" || -z "$life_container" ]]; then
  bad "Could not create the instance for the #8 checks: $lifecycle_json"
  exit 1
fi

inspect_life() { docker inspect -f "$1" "$life_container" 2>/dev/null | tr -d '\r'; }

# Two CPUs and four gigabytes, in the units the Docker API takes them.
check "docker inspect reports the CPU limit" "2000000000" "$(inspect_life '{{.HostConfig.NanoCpus}}')"
check "docker inspect reports the memory limit" "4294967296" "$(inspect_life '{{.HostConfig.Memory}}')"
check "Swap is capped at the memory limit, so the host cannot be paged out" "4294967296" \
  "$(inspect_life '{{.HostConfig.MemorySwap}}')"

info "#8: an instance can be stopped and started instead of only deleted"
check "POST /instances/:id/stop answers 200" "200" "$(status_of POST "/instances/$life_id/stop")"
check "The instance reports exited" "exited" \
  "$(json status <<<"$(body_of GET "/instances/$life_id")")"
check "The container is still there -- a stop is not a delete" "false" \
  "$(inspect_life '{{.State.Running}}')"
check "POST /instances/:id/start answers 200" "200" "$(status_of POST "/instances/$life_id/start")"
check "The instance runs again" "running" \
  "$(json status <<<"$(body_of GET "/instances/$life_id")")"

info "#8 AC 1: a delete leaves neither container nor volume behind"
# A volume the container removal cannot reach on its own: `docker rm -v` takes
# the anonymous ones, not a named one carrying the label.
docker volume create --label "claudops.instance=$life_id" "claudops-smoke-$life_id" >/dev/null
check "The volume is there to begin with" "claudops-smoke-$life_id" "$(volumes_for "$life_id")"
check "DELETE answers 204" "204" "$(status_of DELETE "/instances/$life_id")"
check "No container of the instance remains" "" "$(containers_for "$life_id")"
check "No volume of the instance remains" "" "$(volumes_for "$life_id")"

# ------------------------------------------ #8 AC 2: the restart reconciles
# Three kinds of damage, all of them things a killed server or a hand on the
# NUC really leaves behind.
info "#8 AC 2: a restart with orphaned and hand-removed containers ends consistent"
healthy_json="$(body_of POST /instances "{\"name\":\"smoke-healthy\",\"projectId\":\"$project_id\"}")"
healthy_id="$(json id <<<"$healthy_json")"
healthy_container="$(json containerId <<<"$healthy_json")"

removed_json="$(body_of POST /instances "{\"name\":\"smoke-removed\",\"projectId\":\"$project_id\"}")"
removed_id="$(json id <<<"$removed_json")"
docker rm -f "$(json containerId <<<"$removed_json")" >/dev/null 2>&1

# A labelled container no instance ever pointed at -- a create that died between
# starting the container and writing its id.
docker run -d --name claudops-smoke-orphan --label 'claudops.instance=smoke-orphan' \
  --entrypoint sleep "$IMAGE" 300 >/dev/null
docker volume create --label 'claudops.instance=smoke-orphan' claudops-smoke-orphan-vol >/dev/null

if stop_server "$server_pid" "$BASE"; then
  ok "The server stopped"
else
  bad "The server did not let go of the port"
fi

# The same environment as the first one: this is a restart, not a different
# server.
start_server "$PORT" "$DB_FILE_NATIVE" "$WORK_DIR/server-restart.log" \
  "CLAUDOPS_BASE_IMAGE=$IMAGE" \
  "CLAUDOPS_PROJECT_CONTEXT=$PROJECT_CONTEXT_NATIVE" \
  "CLAUDOPS_SECRET_KEY=$SECRET_KEY" \
  'CLAUDOPS_GIT_USER_NAME=claudops' \
  'CLAUDOPS_GIT_USER_EMAIL=claudops@example.invalid'
server_pid="$SERVER_PID"
SERVER_LOG="$WORK_DIR/server-restart.log"

if wait_for_health "$BASE"; then
  ok "The server came back up"
else
  bad "The restarted server did not become healthy -- log:"
  sed 's/^/        /' "$SERVER_LOG"
  exit 1
fi

# The reconcile runs once at startup and is not awaited by the listen, so the
# assertions poll rather than assume it already happened.
reconciled=""
for _ in $(seq 1 30); do
  if [[ -z "$(containers_for smoke-orphan)" && -z "$(volumes_for smoke-orphan)" ]]; then
    reconciled="yes"
    break
  fi
  sleep 1
done
check "The orphaned container and its volume are gone" "yes" "$reconciled"
check "The instance whose container was removed says so" "missing" \
  "$(json status <<<"$(body_of GET "/instances/$removed_id")")"
check "Its row survives -- only its container is gone" "$removed_id" \
  "$(json id <<<"$(body_of GET "/instances/$removed_id")")"
check "And it no longer points at a container" "" \
  "$(json containerId <<<"$(body_of GET "/instances/$removed_id")")"
check "The healthy instance was left alone" "running" \
  "$(json status <<<"$(body_of GET "/instances/$healthy_id")")"
check "Its container is still running" "true" \
  "$(docker inspect -f '{{.State.Running}}' "$healthy_container" 2>/dev/null | tr -d '\r')"

check "DELETE of the reconciled instance answers 204" "204" \
  "$(status_of DELETE "/instances/$removed_id")"
check "DELETE of the healthy instance answers 204" "204" \
  "$(status_of DELETE "/instances/$healthy_id")"

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

# A second server, whose base image does not exist, is the only way to see a
# build that really fails -- the unit tests can only fake one. It has no secret
# key either, which is the other thing that cannot be faked from in-process.
info "#7 AC 3: a failed build is visible on the project and blocks instance start"
second_port=$((PORT + 1))
second_base="http://127.0.0.1:$second_port"
start_server "$second_port" "$WORK_DIR_NATIVE/no-image.db" "$WORK_DIR/no-image.log" \
  'CLAUDOPS_BASE_IMAGE=claudops-does-not-exist:0' \
  "CLAUDOPS_PROJECT_CONTEXT=$PROJECT_CONTEXT_NATIVE"
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

if wait_for_image "$no_image_project" failed; then
  ok "The project reports its build as failed"
else
  bad "The build of a project on a missing base image did not end up as failed"
fi

failed_log="$(body_of GET "/projects/$no_image_project/build-log")"
check "The failure is readable through the API" "failed" "$(json status <<<"$failed_log")"
if [[ -n "$(json log <<<"$failed_log")" ]]; then
  ok "The build log says what happened"
else
  bad "The failed build kept no log"
fi

refused="$(api POST /instances "{\"name\":\"no-image\",\"projectId\":\"$no_image_project\"}")"
check "POST /instances against a failed image answers 422" "422" "$(head -1 <<<"$refused")"
check "The refusal names the image, not the project" "project_image_not_ready" \
  "$(json error <<<"$(tail -n +2 <<<"$refused")")"
check "No instance was recorded for the failed create" "" \
  "$(json instances.0.id <<<"$(body_of GET /instances)")"
check "An explicit rebuild is accepted and fails again" "202" \
  "$(status_of POST "/projects/$no_image_project/build")"
BASE="http://127.0.0.1:$PORT"

check "Server survived the whole run" "0" "$(kill -0 "$server_pid" 2>/dev/null; echo $?)"

report
