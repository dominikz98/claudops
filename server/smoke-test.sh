#!/usr/bin/env bash
# Smoke test for claudops-server: checks the acceptance criteria from issues #3,
# #6, #7, #8, #15, #16, #17, #18 and #32 against a real Docker daemon and a real
# server process. #8
# needs two server processes on the same database -- the startup reconcile is
# only observable across a restart.
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
# the public claudops repository, and the egress checks of #32 really reach out
# of a container. A CLAUDE_CODE_OAUTH_TOKEN is passed through if set, but is not
# required -- the container stays alive either way.
#
# The terminal bridge of issue #4 has its own script: ./server/terminal-smoke-test.sh
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-lib.sh"

IMAGE="${IMAGE:-claudops-base:smoke}"
PORT="${PORT:-18080}"
BASE="http://127.0.0.1:$PORT"
# The second listener, the one instance containers report to (#17). Unlike the
# API's port it is *not* bound to loopback -- a container reaches it on the
# docker bridge gateway, which is the whole point of it being a separate port.
STATUS_PORT="${STATUS_PORT:-18081}"

DB_FILE="$WORK_DIR/claudops.db"
DB_FILE_NATIVE="$WORK_DIR_NATIVE/claudops.db"
SERVER_LOG="$WORK_DIR/server.log"
GIT_TOKEN_PROBE="smoke-pat-must-not-appear"
# The OAuth token half of "a grep over logs and DB finds no tokens" (#9). A
# stand-in rather than the real one: a fake token still has to stay out of every
# response, out of the database and out of the log, and a real one would put a
# working credential into a temporary directory.
OAUTH_PROBE="smoke-oauth-must-not-appear"
# The same idea for a project variable (#32): it has to arrive in the container
# and appear nowhere else -- not in a response, not on disk, not in the log.
ENV_PROBE="smoke-variable-must-not-appear"
# A host the base image does not whitelist, so reaching it from inside an
# instance proves the project's own list arrived. nuget rather than something
# invented: it is what a dotnet project would actually ask for.
PROJECT_HOST="api.nuget.org"
# The operator's server-wide list. A project adds to this one, it never replaces
# it, and both halves have to show up in the container's FIREWALL_ALLOW.
SERVER_HOST="registry.npmjs.org"
PUBLIC_REPO="https://github.com/dominikz98/claudops.git"
# Deliberately far below the defaults (#15): the refusal of a file over the
# limit has to be reachable without pushing twenty-five megabytes through curl
# on every run. Everything this script uploads is a few dozen bytes.
UPLOAD_MAX_FILE="256k"
# 600 KiB, so three 250 KB files are one too many and the per-instance ceiling
# is reachable in three requests.
UPLOAD_MAX_TOTAL="600k"
UPLOAD_TOO_BIG_BYTES=300000
UPLOAD_FILLER_BYTES=250000
# The same reasoning in the other direction (#18): the refusal of an oversized
# *read* has to be reachable, and the default is ten megabytes.
FILE_MAX_READ="128k"
READ_TOO_BIG_BYTES=200000
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
  "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_PROBE" \
  'CLAUDOPS_GIT_USER_NAME=claudops' \
  'CLAUDOPS_GIT_USER_EMAIL=claudops@example.invalid' \
  "CLAUDOPS_UPLOAD_MAX_FILE=$UPLOAD_MAX_FILE" \
  "CLAUDOPS_UPLOAD_MAX_TOTAL=$UPLOAD_MAX_TOTAL" \
  "CLAUDOPS_FILE_MAX_READ=$FILE_MAX_READ" \
  "CLAUDOPS_STATUS_PORT=$STATUS_PORT" \
  "CLAUDOPS_FIREWALL_ALLOW=$SERVER_HOST"
server_pid="$SERVER_PID"

if wait_for_health "$BASE"; then
  ok "Server is up and Docker is reachable"
else
  bad "Server did not become healthy -- log:"
  sed 's/^/        /' "$SERVER_LOG"
  exit 1
fi

# ---------------------------------------------------- #9: the UI needs a login
# Before anything else uses the API: wait_for_health has already logged in, so
# these run with an explicitly empty cookie jar rather than by ordering.
info "#9 AC 2: the API is unusable without a login"
unauthenticated() {
  curl -s -w '\n%{http_code}' -X "$1" "$BASE$2" | tail -n1 | tr -d '\r'
}
check "GET /instances without a cookie answers 401" "401" "$(unauthenticated GET /instances)"
check "GET /projects without a cookie answers 401" "401" "$(unauthenticated GET /projects)"
# Leaks strictly less than a 404 would: without a session not even the route
# table shows.
check "An unknown route without a cookie answers 401 too" "401" "$(unauthenticated GET /nope)"
check "/health stays reachable, because this harness gates on it" "200" \
  "$(unauthenticated GET /health)"
check "A wrong secret is refused" "401" \
  "$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' \
      -d '{"secret":"not-the-shared-secret"}' "$BASE/login" | tail -n1 | tr -d '\r')"
check "The cookie from the login opens the API" "200" "$(status_of GET /instances)"

# ------------------------------------------------ #6: a project holds the PAT
info "#6: creating a project with a PAT"
created="$(api POST /projects "{\"name\":\"smoke\",\"repoUrl\":\"https://github.com/dominikz98/does-not-exist.git\",\"repoBranch\":\"main\",\"gitToken\":\"$GIT_TOKEN_PROBE\",\"buildingBlocks\":{\"dotnet\":true,\"playwright\":false},\"env\":{\"SMOKE_VARIABLE\":\"$ENV_PROBE\",\"SMOKE_EMPTY\":\"\"},\"egressHosts\":[\"$PROJECT_HOST\"]}")"
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

# ------------------------------------ #32: a project carries its own environment
# The same three properties as the PAT, one level down: the value is write-only,
# sealed on disk and absent from the log. The names are not secret -- they are
# what the UI lists and what a PATCH addresses a single variable by.
info "#32 AC 3: a project's variables are write-only and sealed on disk"
check "The project answers with its variable names" "SMOKE_EMPTY" \
  "$(json envNames.0 <<<"$project_json")"
check "And with the second one" "SMOKE_VARIABLE" "$(json envNames.1 <<<"$project_json")"
check "The value is not in the response" "0" "$(grep -c "$ENV_PROBE" <<<"$project_json")"
check "The value is not readable on disk" "0" "$(db_bytes | grep -ac "$ENV_PROBE" || true)"
check "The value is not in the server log" "0" \
  "$(grep -c "$ENV_PROBE" "$SERVER_LOG" | tr -d '\r')"
check "The egress hosts do come back -- they are not secret" "$PROJECT_HOST" \
  "$(json egressHosts.0 <<<"$project_json")"

info "#32 AC 2: a project cannot take over a variable claudops manages"
for managed in GIT_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do
  check "POST with $managed answers 409" "409" \
    "$(status_of POST /projects \
        "{\"name\":\"hostile-$managed\",\"repoUrl\":\"$PUBLIC_REPO\",\"env\":{\"$managed\":\"mine\"}}")"
done
check "A PATCH cannot smuggle one in either" "409" \
  "$(status_of PATCH "/projects/$project_id" '{"env":{"GIT_TOKEN":"mine"}}')"
check "A host the firewall could not use is refused" "400" \
  "$(status_of POST /projects \
      "{\"name\":\"bad-host\",\"repoUrl\":\"$PUBLIC_REPO\",\"egressHosts\":[\"https://api.example.com/v1\"]}")"
check "And so is a wildcard, which an ipset cannot hold" "400" \
  "$(status_of POST /projects \
      "{\"name\":\"wild\",\"repoUrl\":\"$PUBLIC_REPO\",\"egressHosts\":[\"*.example.com\"]}")"

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

# --------------------------- #32 AC 1: the project's variables are in the container
info "#32 AC 1: a variable set on the project shows in docker inspect"
if container_env "$container_id" | grep -q "^SMOKE_VARIABLE=$ENV_PROBE$"; then
  ok "SMOKE_VARIABLE is the decrypted value of the project variable"
else
  bad "SMOKE_VARIABLE did not reach the container"
fi
# Empty but present: a variable that exists and says nothing is a legitimate
# thing to hand a program, unlike a server setting nobody configured.
check "An empty variable is present rather than dropped" "1" \
  "$(container_env "$container_id" | grep -c '^SMOKE_EMPTY=$' | tr -d '\r')"
check "FIREWALL_ALLOW carries the server-wide list and the project's, in that order" \
  "FIREWALL_ALLOW=$SERVER_HOST,$PROJECT_HOST" \
  "$(container_env "$container_id" | grep '^FIREWALL_ALLOW=' | tr -d '\r')"
check "Token is not echoed back by the API" "0" \
  "$(grep -c "$GIT_TOKEN_PROBE" <<<"$instance_json")"
check "Token still not readable on disk" "0" \
  "$(db_bytes | grep -ac "$GIT_TOKEN_PROBE" || true)"
check "Token still not in the server log" "0" \
  "$(grep -c "$GIT_TOKEN_PROBE" "$SERVER_LOG" | tr -d '\r')"

# ------------------------------------------- #9 AC 3: no tokens in log or DB
# The PAT above is one of the three credentials claudops handles; these are the
# other two. The OAuth token reaches the container and nothing else, and the
# login secret never leaves the server's own environment at all.
info "#9 AC 3: a grep over logs and DB finds no tokens"
if container_env "$container_id" | grep -q "^CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_PROBE$"; then
  ok "The OAuth token reached the container"
else
  bad "CLAUDE_CODE_OAUTH_TOKEN did not reach the container"
fi
check "The OAuth token is not echoed back by the API" "0" \
  "$(grep -c "$OAUTH_PROBE" <<<"$instance_json")"
check "The OAuth token is not in the instance list either" "0" \
  "$(grep -c "$OAUTH_PROBE" <<<"$(body_of GET /instances)")"
check "The OAuth token is not on disk" "0" \
  "$(db_bytes | grep -ac "$OAUTH_PROBE" || true)"
check "The OAuth token is not in the server log" "0" \
  "$(grep -c "$OAUTH_PROBE" "$SERVER_LOG" | tr -d '\r')"
check "The login secret is not on disk" "0" \
  "$(db_bytes | grep -ac "$SMOKE_LOGIN_SECRET" || true)"
# It is posted to /login on every run, so this is the redaction of req.body.secret
# doing its job rather than an accident.
check "The login secret is not in the server log" "0" \
  "$(grep -c "$SMOKE_LOGIN_SECRET" "$SERVER_LOG" | tr -d '\r')"
check "The session cookie is not in the server log" "0" \
  "$(grep -c 'claudops_session=' "$SERVER_LOG" | tr -d '\r')"
check "The container never sees the login secret" "0" \
  "$(container_env "$container_id" | grep -c "$SMOKE_LOGIN_SECRET" | tr -d '\r')"


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

# ------------------------------ #32 AC 4: the project's hosts are on the whitelist
# The container's own firewall is what makes this true, so it has to be up
# before either probe means anything -- a sealed container refuses both, and a
# container without CAP_NET_ADMIN allows both.
info "#32 AC 4: a host the project listed answers, one it did not is refused"
# Polled, not read once: the script writes 'configuring' before it starts and
# settles only after it has resolved a dozen names and GitHub's ranges, which is
# seconds to a minute. Reading the file straight after the create asserts on a
# state that has not happened yet
# (knowledge/a-smoke-test-must-wait-for-the-state-it-asserts-on.md).
firewall_state=""
for _ in $(seq 1 90); do
  firewall_state="$(docker exec "$container_id" head -1 /run/claudops-firewall.state 2>/dev/null | tr -d '\r')"
  [[ -n "$firewall_state" && "$firewall_state" != 'configuring' ]] && break
  sleep 2
done
check "The instance's egress firewall came up" "active" "${firewall_state:-<no state file>}"

if [[ "$firewall_state" == 'active' ]]; then
  check "The project's host is reachable from inside the instance" "0" \
    "$(docker exec "$container_id" curl -sS --max-time 15 -o /dev/null "https://$PROJECT_HOST/v3/index.json" >/dev/null 2>&1; echo $?)"
  unlisted_rc="$(docker exec "$container_id" curl -sS --max-time 5 -o /dev/null https://example.com >/dev/null 2>&1; echo $?)"
  if [[ "$unlisted_rc" != "0" ]]; then
    ok "A host nobody listed is refused (curl exit $unlisted_rc)"
  else
    bad "example.com was reachable -- the instance is not filtering"
  fi
  # The ipset is the whitelist itself: a rule in the chain would let a host
  # through that the resolved addresses do not cover, and the other way round.
  check "The project's host resolved into the container's ipset" "0" \
    "$(docker exec -u root "$container_id" sh -c \
        "getent ahostsv4 $PROJECT_HOST | awk 'NR==1{print \$1}' | xargs -r ipset test claudops-allow" \
        >/dev/null 2>&1; echo $?)"
else
  bad "Skipping the egress probes -- the firewall is '$firewall_state', not 'active'"
fi

# One variable at a time, like the PAT's own Remove: what is stored is not shown,
# so it cannot be edited in place -- a name has to be addressable on its own.
info "#32: a single variable can be removed without touching the others"
after_removal="$(body_of PATCH "/projects/$project_id" '{"env":{"SMOKE_EMPTY":null}}')"
check "The removed variable is gone" "SMOKE_VARIABLE" "$(json envNames.0 <<<"$after_removal")"
check "And it was the only one removed" "" "$(json envNames.1 <<<"$after_removal")"
check "The image is untouched by it" "ready" "$(json image.status <<<"$after_removal")"

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

# Waiting for the branch rather than for `.git`: git creates that directory
# early and only writes HEAD at the end, so a check that stops at the directory
# can read back "HEAD" from a clone that is still running -- which looks exactly
# like a container that ignored REPO_BRANCH.
cloned=""
clone_branch=""
for _ in $(seq 1 60); do
  clone_branch="$(docker exec "$clone_container" \
    git -C /workspace/claudops rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\r')"
  if [[ -n "$clone_branch" && "$clone_branch" != 'HEAD' ]]; then
    cloned="yes"
    break
  fi
  sleep 2
done
check "The repository is cloned into /workspace/claudops" "yes" "$cloned"
check "The checked out branch is the one the project names" "main" "$clone_branch"
check "No token ends up in the remote URL" "0" \
  "$(docker exec "$clone_container" git -C /workspace/claudops remote get-url origin 2>/dev/null | grep -c '@')"


# --------------------------------------------- #15: attachments reach the agent
# Against the clone instance on purpose: only an instance with a real repository
# can show that an upload stays out of its `git status`.
info "#15: a file uploaded through the API arrives in the container"

# curl rather than api(): the body of an upload is the file's bytes and its name
# travels in the query, so the JSON helper cannot send one.
upload() {
  local id="$1" name="$2" file="$3" raw
  raw="$(curl -s -w '\n%{http_code}' -b "$COOKIE_JAR_NATIVE" \
    -X POST -H 'content-type: application/octet-stream' \
    --data-binary "@$(native "$file")" "$BASE/instances/$id/files?name=$name")"
  printf '%s\n%s' "$(tail -n1 <<<"$raw")" "$(sed '$d' <<<"$raw")"
}

# The session, not just the container: the path is typed into tmux, and tmux
# exists a while after the container is up (#25).
session_ready=""
for _ in $(seq 1 90); do
  if [[ "$(json session <<<"$(body_of GET "/instances/$clone_id")")" == "ready" ]]; then
    session_ready="yes"
    break
  fi
  sleep 2
done
check "The session is up before anything is attached" "yes" "$session_ready"

probe_file="$WORK_DIR/upload-probe.png"
printf 'PNG-PROBE-%s' "$" > "$probe_file"
probe_bytes="$(wc -c < "$probe_file" | tr -d ' \r')"
uploads_dir="/workspace/.claudops/uploads"

uploaded="$(upload "$clone_id" "probe.png" "$probe_file")"
upload_body="$(tail -n +2 <<<"$uploaded")"
check "POST /instances/:id/files answers 201" "201" "$(head -1 <<<"$uploaded")"
check "The answer names the path outside the clone" "$uploads_dir/probe.png" \
  "$(json path <<<"$upload_body")"
check "The answer reports the size that was sent" "$probe_bytes" "$(json size <<<"$upload_body")"

check "AC 2: the file is really in the container, byte for byte" "$(cat "$probe_file")" \
  "$(docker exec "$clone_container" cat "$uploads_dir/probe.png" 2>/dev/null | tr -d '\r')"
# The tar header carries uid 1001; a 0 there would hand the agent a file it
# cannot write (knowledge/putarchive-writes-the-uid-from-the-tar-header.md).
check "It belongs to the agent, not to root" "claude" \
  "$(docker exec "$clone_container" stat -c '%U' "$uploads_dir/probe.png" 2>/dev/null | tr -d '\r')"

check "AC 1: the path was written into the tmux session" "true" \
  "$(json announced <<<"$upload_body")"
if docker exec "$clone_container" tmux capture-pane -p -t main 2>/dev/null \
     | tr -d '\r' | grep -qF "$uploads_dir/probe.png"; then
  ok "The path is visible in the pane, so it is in the prompt"
else
  bad "The path never reached the tmux pane"
fi

# AC 3. The uploads directory is a sibling of the clone, not a child of it, so
# this holds by the path rather than by a .gitignore.
check "AC 3: the upload does not show up in git status" "" \
  "$(docker exec "$clone_container" git -C /workspace/claudops status --porcelain 2>/dev/null | tr -d '\r')"

traversal="$(upload "$clone_id" "..%2F..%2Fetc%2Fpasswd" "$probe_file")"
check "A traversal in the name stays inside the uploads directory" "$uploads_dir/passwd" \
  "$(json path <<<"$(tail -n +2 <<<"$traversal")")"
check "And nothing was written outside it" "0" \
  "$(docker exec "$clone_container" grep -c 'PNG-PROBE' /etc/passwd 2>/dev/null | tr -d '\r')"

info "#15 AC 4: a file over the limit is refused and the server stays up"
big_file="$WORK_DIR/too-big.bin"
head -c "$UPLOAD_TOO_BIG_BYTES" /dev/zero > "$big_file"

oversize="$(upload "$clone_id" "too-big.bin" "$big_file")"
check "An upload over CLAUDOPS_UPLOAD_MAX_FILE answers 413" "413" "$(head -1 <<<"$oversize")"
check "The refusal says what was wrong" "upload_too_large" \
  "$(json error <<<"$(tail -n +2 <<<"$oversize")")"
check "Nothing of it was written" "" \
  "$(docker exec "$clone_container" ls "$uploads_dir/too-big.bin" 2>/dev/null | tr -d '\r')"
check "The server is still healthy afterwards" "200" "$(status_of GET /health)"
check "And still takes a file that fits" "201" \
  "$(head -1 <<<"$(upload "$clone_id" "after-the-refusal.txt" "$probe_file")")"


# The per-instance ceiling is the one assertion that proves the byte
# accounting really reads the container: the server sums what `find -printf`
# reported over a demultiplexed exec stream, and a stream read raw would
# produce no number at all and let all three through
# (knowledge/a-non-tty-exec-is-framed.md).
info "#15: the per-instance ceiling counts what is already in the container"
filler_file="$WORK_DIR/filler.bin"
head -c "$UPLOAD_FILLER_BYTES" /dev/zero > "$filler_file"

check "The first filler fits" "201" \
  "$(head -1 <<<"$(upload "$clone_id" "filler-1.bin" "$filler_file")")"
check "The second one still fits" "201" \
  "$(head -1 <<<"$(upload "$clone_id" "filler-2.bin" "$filler_file")")"
third_filler="$(upload "$clone_id" "filler-3.bin" "$filler_file")"
check "The third is over CLAUDOPS_UPLOAD_MAX_TOTAL" "413" "$(head -1 <<<"$third_filler")"
check "And says so" "upload_too_large" \
  "$(json error <<<"$(tail -n +2 <<<"$third_filler")")"
check "Deleting one in the container frees the budget again" "201" \
  "$(docker exec "$clone_container" rm "$uploads_dir/filler-1.bin" >/dev/null 2>&1; \
     head -1 <<<"$(upload "$clone_id" "filler-3.bin" "$filler_file")")"

# --------------------------------------- #18: reading what the instance produced
# Still against the clone instance: a real repository is what makes the listing
# a listing of something, and the clone's own files are what a browser would be
# looking at.
info "#18: the workspace is browsable and its files readable"

# curl again rather than api(): a content response is bytes with headers that
# matter, and neither survives the JSON helper.
raw_get() {
  curl -s -w '\n%{http_code}' -b "$COOKIE_JAR_NATIVE" "$BASE$1"
}
headers_of() {
  curl -s -o /dev/null -D - -b "$COOKIE_JAR_NATIVE" "$BASE$1" | tr -d '\r'
}
# A path in a query string. printf %s through jq would be another dependency;
# these paths are ASCII and the two characters that matter are the slash and
# the dot-dot.
urlenc() { printf '%s' "$1" | sed -e 's|/|%2F|g' -e 's|\.\.|%2E%2E|g'; }

report_body='# Smoke report

Written **inside** the container, never committed.
'
docker exec "$clone_container" sh -c 'cat > /workspace/claudops/SMOKE.md' <<<"$report_body" \
  >/dev/null 2>&1
docker exec "$clone_container" truncate -s "$READ_TOO_BIG_BYTES" /workspace/claudops/big.bin \
  >/dev/null 2>&1
docker exec "$clone_container" ln -sfn /etc/passwd /workspace/escape.txt >/dev/null 2>&1
docker exec "$clone_container" ln -sfn /etc /workspace/outside >/dev/null 2>&1

root_listing="$(body_of GET "/instances/$clone_id/files")"
check "GET /instances/:id/files answers for the workspace root" "/workspace" \
  "$(json path <<<"$root_listing")"
contains "The clone is in it" '"name":"claudops"' "$root_listing"
contains "And so is the uploads directory of #15" '"name":".claudops"' "$root_listing"
# `path` and `kind` are adjacent in the entry; `name` is not next to either.
contains "A symlink is neither a file nor a directory" \
  '"path":"/workspace/escape.txt","kind":"other"' "$(tr -d ' ' <<<"$root_listing")"

repo_listing="$(body_of GET "/instances/$clone_id/files?path=$(urlenc /workspace/claudops)")"
contains "A directory below it lists what the clone holds" '"name":"SMOKE.md"' "$repo_listing"
contains "With the path the next request needs" \
  '"path":"/workspace/claudops/SMOKE.md"' "$(tr -d ' ' <<<"$repo_listing")"

info "#18 AC 2: a file Claude wrote comes back as it was written"
md="$(raw_get "/instances/$clone_id/files/content?path=$(urlenc /workspace/claudops/SMOKE.md)")"
check "Reading it answers 200" "200" "$(tail -n1 <<<"$md")"
contains "And the Markdown is intact" 'Written **inside** the container' "$(sed '$d' <<<"$md")"

md_headers="$(headers_of "/instances/$clone_id/files/content?path=$(urlenc /workspace/claudops/SMOKE.md)")"
# Never text/html and never sniffable: this is content an agent wrote, served
# from claudops' own origin to a browser carrying the session cookie.
contains "It is served as plain text" 'content-type: text/plain' "$md_headers"
contains "Nothing may sniff it into something else" 'x-content-type-options: nosniff' "$md_headers"
contains "And a tab opened on it has no origin" "content-security-policy: default-src 'none'; sandbox" \
  "$md_headers"
contains "?download=1 turns the same URL into a Save as" 'content-disposition: attachment' \
  "$(headers_of "/instances/$clone_id/files/content?path=$(urlenc /workspace/claudops/SMOKE.md)&download=1")"

info "#18 AC 1: an attachment is readable back through the API, byte for byte"
shot="$(raw_get "/instances/$clone_id/files/content?path=$(urlenc "$uploads_dir/probe.png")")"
check "The uploaded file reads back" "200" "$(tail -n1 <<<"$shot")"
check "With exactly the bytes that went in" "$(cat "$probe_file")" "$(sed '$d' <<<"$shot")"

info "#18 AC 3: nothing outside the workspace is readable"
for path in "../../etc/passwd" "/etc/passwd" "/workspace/../etc/passwd"; do
  refusal="$(raw_get "/instances/$clone_id/files/content?path=$(urlenc "$path")")"
  check "Reading '$path' answers 400" "400" "$(tail -n1 <<<"$refusal")"
  check "And says why" "path_outside_workspace" "$(json error <<<"$(sed '$d' <<<"$refusal")")"
  check "And no line of /etc/passwd came back" "0" \
    "$(grep -c 'root:x:' <<<"$refusal" || true)"
done
check "Listing /etc answers 400 as well" "400" \
  "$(status_of GET "/instances/$clone_id/files?path=$(urlenc /etc)")"

# The one the server cannot decide on the string it was sent: the path is in
# the workspace and what it points at is not. Only the container knows, which
# is why the scripts resolve it there a second time.
escape="$(raw_get "/instances/$clone_id/files/content?path=$(urlenc /workspace/escape.txt)")"
check "A symlink out of the workspace is refused" "400" "$(tail -n1 <<<"$escape")"
check "And is not followed" "0" "$(grep -c 'root:x:' <<<"$escape" || true)"
check "Nor is a path through a symlinked directory" "400" \
  "$(status_of GET "/instances/$clone_id/files?path=$(urlenc /workspace/outside)")"

info "#18 AC 4: a file over the limit is refused instead of being read"
oversize_read="$(raw_get "/instances/$clone_id/files/content?path=$(urlenc /workspace/claudops/big.bin)")"
check "A read over CLAUDOPS_FILE_MAX_READ answers 413" "413" "$(tail -n1 <<<"$oversize_read")"
check "The refusal says what was wrong" "file_too_large" \
  "$(json error <<<"$(sed '$d' <<<"$oversize_read")")"
check "The server is still healthy afterwards" "200" "$(status_of GET /health)"
check "And still reads a file that fits" "200" \
  "$(tail -n1 <<<"$(raw_get "/instances/$clone_id/files/content?path=$(urlenc /workspace/claudops/SMOKE.md)")")"

check "A directory asked for its bytes answers 400" "400" \
  "$(status_of GET "/instances/$clone_id/files/content?path=$(urlenc /workspace/claudops)")"
check "A path that is not there is a 404 about the path" "path_not_found" \
  "$(json error <<<"$(body_of GET "/instances/$clone_id/files/content?path=$(urlenc /workspace/claudops/nope.txt)")")"

# Reading is reading: the only two entries git sees are the two fixtures
# written above, and nothing the browsing added.
check "Browsing added nothing to the clone" "2" \
  "$(docker exec "$clone_container" git -C /workspace/claudops status --porcelain 2>/dev/null \
     | tr -d '\r' | grep -c . )"


check "DELETE of the clone instance answers 204" "204" "$(status_of DELETE "/instances/$clone_id")"
check "DELETE of the clone project answers 204" "204" "$(status_of DELETE "/projects/$clone_project")"

# ------------------------------------------- #16: model and effort per instance
info "#16: the model is chosen on create and switched on a running instance"

model_created="$(api POST /instances \
  "{\"name\":\"smoke-model\",\"projectId\":\"$project_id\",\"model\":\"haiku\",\"effort\":\"low\"}")"
check "POST with a model answers 201" "201" "$(head -1 <<<"$model_created")"

model_json="$(tail -n +2 <<<"$model_created")"
model_id="$(json id <<<"$model_json")"
model_container="$(json containerId <<<"$model_json")"
check "The instance reports the chosen model" "haiku" "$(json model <<<"$model_json")"
check "The instance reports the chosen effort" "low" "$(json effort <<<"$model_json")"

check "An unknown model is refused" "400" \
  "$(status_of POST /instances \
      "{\"name\":\"nope\",\"projectId\":\"$project_id\",\"model\":\"gpt-4\"}")"

# What the server is responsible for: the choice reaches the container as an
# environment variable. That the entrypoint turns it into `--model` on the
# `claude` line is the base image's own smoke test.
container_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \
  "$model_container" 2>/dev/null | tr -d '\r')"
contains "The container carries CLAUDE_MODEL" "CLAUDE_MODEL=haiku" "$container_env"
contains "The container carries CLAUDE_EFFORT" "CLAUDE_EFFORT=low" "$container_env"

# A switch types into the session, so there has to be one. Right after a create
# there is not -- the healthcheck has not run once. Tolerant rather than timed:
# on a slow enough host the first check could already have passed, and the
# deterministic version of this assertion is in server/test/routes.test.ts.
early="$(api PATCH "/instances/$model_id" '{"model":"opus"}')"
if [[ "$(head -1 <<<"$early")" == '409' ]]; then
  ok "A switch before the session is up is refused, not half-applied"
  check "The refusal names the session, not the container" "session_not_ready" \
    "$(json error <<<"$(tail -n +2 <<<"$early")")"
else
  info "  (the session was already up -- nothing to refuse)"
fi

session_ready=''
for _ in $(seq 1 90); do
  [[ "$(json session <<<"$(body_of GET "/instances/$model_id")")" == 'ready' ]] && {
    session_ready=yes
    break
  }
  sleep 1
done

if [[ -z "$session_ready" ]]; then
  bad "The session never became ready -- nothing to switch a model on"
else
  ok "The session became ready"

  switched="$(api PATCH "/instances/$model_id" '{"model":"opus"}')"
  check "PATCH answers 200" "200" "$(head -1 <<<"$switched")"
  check "The new model comes back" "opus" "$(json model <<<"$(tail -n +2 <<<"$switched")")"
  check "The effort that was not sent is kept" "low" \
    "$(json effort <<<"$(tail -n +2 <<<"$switched")")"

  # Half one: the running session was typed into. Whether Claude is at a prompt
  # in there or the pane fell back to a shell, the line is on it either way.
  contains "The slash command reached the pane" "/model opus" \
    "$(docker exec "$model_container" tmux capture-pane -p -t main:0.0 2>/dev/null | tr -d '\r')"

  # Half two: what the next container start will read. Without it a stop/start
  # would bring haiku back from the environment above.
  check "The override file carries the new model" "opus" \
    "$(docker exec "$model_container" cat /home/claude/.claudops/model 2>/dev/null | tr -d '\r')"
  check "The untouched effort is in its file too" "low" \
    "$(docker exec "$model_container" cat /home/claude/.claudops/effort 2>/dev/null | tr -d '\r')"

  check "An unknown value is refused on a PATCH as well" "400" \
    "$(status_of PATCH "/instances/$model_id" '{"effort":"ludicrous"}')"
  check "The stored model survived the refusal" "opus" \
    "$(json model <<<"$(body_of GET "/instances/$model_id")")"
fi

# ------------------------------- #17: the instance says what Claude is doing
# The whole loop in one place: a hook fires inside the container, the container
# reaches the status listener on the docker bridge gateway -- the one address
# its egress firewall lets through -- proves which instance it is with the token
# claudops created it with, and `GET /instances/:id` answers differently.
#
# The hooks are fired by hand, with the JSON Claude Code puts on their stdin,
# rather than by waiting for Claude to do something: that would need a real
# OAuth token and a turn to watch, and neither says more about this path than
# the four events do.
if [[ -n "$session_ready" ]]; then
  info "#17: an instance reports what Claude is doing"

  # `docker exec` inherits the container's own environment, which is where the
  # port, the instance id and the token are -- exactly what a hook has.
  hook() {
    docker exec -i "$model_container" /usr/local/bin/claudops-status <<<"$1" 2>&1
  }
  activity_of() { json activity <<<"$(body_of GET "/instances/$model_id")"; }

  check "An instance nobody has asked anything is idle" "idle" "$(activity_of)"

  # Nothing on stdout, ever: a UserPromptSubmit hook's output is added to the
  # conversation as context.
  check "The hook prints nothing at all" "" \
    "$(hook '{"hook_event_name":"UserPromptSubmit","user_input":"do it"}')"
  check "A submitted prompt shows as running" "running" "$(activity_of)"

  hook '{"hook_event_name":"Notification","notification_type":"elicitation_dialog"}' >/dev/null
  check "AC 1: a question shows as needs input, with no console open" "needs_input" \
    "$(activity_of)"

  hook '{"hook_event_name":"UserPromptSubmit","user_input":"yes"}' >/dev/null
  check "AC 2: answering puts it back on running" "running" "$(activity_of)"

  hook '{"hook_event_name":"Stop","last_assistant_message":"finished"}' >/dev/null
  check "AC 2: finishing shows as done" "done" "$(activity_of)"

  hook '{"hook_event_name":"Notification","notification_type":"idle_prompt"}' >/dev/null
  check "The sixty-second idle nag is not read as a question" "done" "$(activity_of)"

  # What the token is for: one instance may not speak for another, and nothing
  # else on the network may speak for any of them.
  check "A report with the wrong token stays as quiet as any other" "" \
    "$(docker exec -i -e CLAUDOPS_STATUS_TOKEN=not-the-token "$model_container" \
        /usr/local/bin/claudops-status <<<'{"hook_event_name":"UserPromptSubmit"}' 2>&1)"
  check "... and changes nothing" "done" "$(activity_of)"
  check "The refusal is in the server log" "1" \
    "$(grep -c 'status report with no valid token' "$SERVER_LOG" | tr -d '\r')"
  check "The token itself is not" "0" \
    "$(grep -c 'not-the-token' "$SERVER_LOG" | tr -d '\r')"

  # AC 4: the process that would have sent a Stop is gone with the container,
  # so the `done` it last reported must not be what the list keeps showing.
  docker stop "$model_container" >/dev/null 2>&1
  check "AC 4: a container that died ends in a terminal status" "exited" \
    "$(json status <<<"$(body_of GET "/instances/$model_id")")"
  check "AC 4: and reports no activity at all rather than a stale one" "none" "$(activity_of)"
fi

# Removed again, so the list assertions below still see exactly one instance.
check "DELETE of the model instance answers 204" "204" \
  "$(status_of DELETE "/instances/$model_id")"

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
# Given a model on purpose: #16 AC 3 is that the choice survives a server
# restart, and this is the instance meant to come through one intact.
healthy_json="$(body_of POST /instances \
  "{\"name\":\"smoke-healthy\",\"projectId\":\"$project_id\",\"model\":\"sonnet\",\"effort\":\"high\"}")"
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
  "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_PROBE" \
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

# #16 AC 3: the model is the one thing about an instance the database keeps,
# so a restarted server still knows it.
check "#16: the chosen model survived the server restart" "sonnet" \
  "$(json model <<<"$(body_of GET "/instances/$healthy_id")")"
check "#16: the chosen effort survived it too" "high" \
  "$(json effort <<<"$(body_of GET "/instances/$healthy_id")")"

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
  "$(status_of POST /projects '{"name":"x","repoUrl":"https://host/r.git","secrets":{}}')"
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
# +2 and +3, not +1: PORT+1 is the status listener of the server above, which
# binds 0.0.0.0 rather than loopback -- a second API on it never comes up, and
# every check below then reads an empty answer. Its own status port is named for
# the same reason: the default is 8081, which is whatever else is on the box.
second_port=$((PORT + 2))
second_base="http://127.0.0.1:$second_port"
start_server "$second_port" "$WORK_DIR_NATIVE/no-image.db" "$WORK_DIR/no-image.log" \
  'CLAUDOPS_BASE_IMAGE=claudops-does-not-exist:0' \
  "CLAUDOPS_PROJECT_CONTEXT=$PROJECT_CONTEXT_NATIVE" \
  "CLAUDOPS_STATUS_PORT=$((PORT + 3))"

if wait_for_health "$second_base"; then
  ok "The second server is up"
else
  bad "The second server did not become healthy -- log:"
  sed 's/^/        /' "$WORK_DIR/no-image.log"
fi

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
