#!/usr/bin/env bash
# Smoke test for claudops-base: checks the acceptance criteria from issue #2
# against a genuinely running container.
#
#   ./docker/base/smoke-test.sh              # builds the image and tests
#   SKIP_BUILD=1 ./docker/base/smoke-test.sh # uses an existing image
#
# A CLAUDE_CODE_OAUTH_TOKEN, if set, is passed through, but is not required.
set -uo pipefail

# Otherwise Git Bash/MSYS rewrites arguments like "/workspace/..." into Windows
# paths and the container checks would test nothing. No effect on Linux.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-claudops-base:test}"
CONTAINER="${CONTAINER:-claudops-smoke}"
# A second container, started *without* --cap-add=NET_ADMIN, to check what the
# entrypoint does when the firewall cannot come up.
NOCAP="${CONTAINER}-nocap"
# A third one, with its entrypoint replaced by a sleep: what a container that
# never reaches its tmux session looks like to the healthcheck.
NOSESSION="${CONTAINER}-nosession"
TEST_REPO="${TEST_REPO:-https://github.com/dominikz98/claudops.git}"
# Issue #16: what the container is started with, and what a switch from the UI
# writes over it. Aliases, not model ids -- the same list the server offers.
START_MODEL='haiku'
START_EFFORT='low'
SWITCHED_MODEL='sonnet'
TEST_BRANCH="${TEST_BRANCH:-main}"
REPO_DIR="/workspace/claudops"
MARKER="CLAUDOPS_SCROLLBACK_MARKER"
# Issue #17: what claudops hands a container so its hooks can report what Claude
# is doing. Nothing listens on the port during this run -- that end-to-end is
# server/smoke-test.sh. What is checked here is the container's half: the one
# firewall rule, the hooks, and a script that stays quiet whatever happens.
STATUS_PORT="19081"
STATUS_INSTANCE="smoke-instance-id"
STATUS_TOKEN="smoke-status-token"

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

dexec() { docker exec "$CONTAINER" "$@"; }

cleanup() { docker rm -f "$CONTAINER" "$NOCAP" "$NOSESSION" >/dev/null 2>&1; }
trap cleanup EXIT

# ---------------------------------------------------------------- build & start
if [[ -z "${SKIP_BUILD:-}" ]]; then
  info "Building image ($IMAGE)"
  build_context="$SCRIPT_DIR"
  command -v cygpath >/dev/null 2>&1 && build_context="$(cygpath -w "$SCRIPT_DIR")"
  docker build -t "$IMAGE" "$build_context" || { bad "docker build"; exit 1; }
fi

info "Starting container"
cleanup
docker run -d --name "$CONTAINER" \
  --cap-add=NET_ADMIN \
  -e REPO_URL="$TEST_REPO" \
  -e REPO_BRANCH="$TEST_BRANCH" \
  -e GIT_USER_NAME="claudops" \
  -e GIT_USER_EMAIL="claudops@example.invalid" \
  -e CLAUDE_MODEL="$START_MODEL" \
  -e CLAUDE_EFFORT="$START_EFFORT" \
  -e CLAUDOPS_STATUS_PORT="$STATUS_PORT" \
  -e CLAUDOPS_INSTANCE_ID="$STATUS_INSTANCE" \
  -e CLAUDOPS_STATUS_TOKEN="$STATUS_TOKEN" \
  ${CLAUDE_CODE_OAUTH_TOKEN:+-e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"} \
  "$IMAGE" >/dev/null || { bad "docker run"; exit 1; }

# Wait for clone + session
for _ in $(seq 1 60); do
  dexec tmux has-session -t main >/dev/null 2>&1 && break
  sleep 1
done

# ------------------------------------------------- AC: repo cloned, non-root
info "AC 1: docker run clones the repo and starts Claude Code in tmux"
check "Repo is in $REPO_DIR" "yes" \
  "$(dexec sh -c "[ -d $REPO_DIR/.git ] && echo yes || echo no" 2>/dev/null | tr -d '\r')"
check "Branch is $TEST_BRANCH" "$TEST_BRANCH" \
  "$(dexec git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\r')"
check "tmux session 'main' exists" "main" \
  "$(dexec tmux list-sessions -F '#{session_name}' 2>/dev/null | tr -d '\r')"

claude_procs="$(dexec pgrep -fc 'claude' 2>/dev/null | tr -d '\r')"
if [[ "${claude_procs:-0}" -ge 1 ]]; then
  ok "Claude Code process is running in the container ($claude_procs)"
else
  bad "No Claude Code process found -- pane content:"
  dexec tmux capture-pane -p -t main:0.0 2>/dev/null | sed 's/^/        /'
fi
check "Claude CLI is installed" "0" \
  "$(dexec claude --version >/dev/null 2>&1; echo $?)"

# -------------------------------------------- AC (#26): no onboarding wizard
info "AC (#26): the first attach lands in Claude, not in a wizard"

# Claude paints its first frame seconds after the pane exists, so wait for a
# frame that is recognisably either the settled prompt or one of the three
# wizards -- capturing earlier would assert against an empty pane.
pane=''
for _ in $(seq 1 45); do
  pane="$(dexec tmux capture-pane -p -t main:0.0 2>/dev/null | tr -d '\r')"
  grep -qE 'bypass permissions on|Choose the text style|Quick safety check|By proceeding, you accept' \
    <<<"$pane" && break
  sleep 1
done

wizard=''
grep -q 'Choose the text style'     <<<"$pane" && wizard="theme picker"
grep -q 'Quick safety check'        <<<"$pane" && wizard="${wizard:+$wizard, }trust prompt"
grep -q 'By proceeding, you accept' <<<"$pane" && wizard="${wizard:+$wizard, }bypass warning"

if [[ -n "$wizard" ]]; then
  bad "An onboarding wizard is showing: $wizard"
elif grep -q 'bypass permissions on' <<<"$pane"; then
  ok "Claude is at its prompt, no wizard in the way"
else
  bad "Claude never painted a prompt -- pane content:"
  printf '%s\n' "$pane" | sed 's/^/        /'
fi

# The flags themselves, so a Claude release that renames one is caught here
# rather than by someone staring at a wizard
# (knowledge/claude-onboarding-must-be-pre-seeded.md).
check "Onboarding is marked complete" "true" \
  "$(dexec jq -r '.hasCompletedOnboarding' /home/claude/.claude.json 2>/dev/null | tr -d '\r')"
check "The clone directory is trusted" "true" \
  "$(dexec jq -r --arg d "$REPO_DIR" '.projects[$d].hasTrustDialogAccepted' \
      /home/claude/.claude.json 2>/dev/null | tr -d '\r')"
check "No Claude token in the config" "0" \
  "$(dexec grep -c 'sk-ant' /home/claude/.claude.json 2>/dev/null | tr -d '\r')"

# ------------------------------------------------ AC (#25): readiness reporting
info "AC (#25): the container reports whether its session is up"

# The healthcheck is what the claudops server reads to tell "container running"
# from "console attachable". A timer on the server side would get this wrong for
# every repository size, which is why the container answers instead.
health=''
for _ in $(seq 1 30); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null | tr -d '\r')"
  [[ "$health" == 'healthy' ]] && break
  sleep 1
done
check "Health reports the session as up" "healthy" "$health"

# The other half: a container that never reaches tmux has to end somewhere
# rather than stay `starting` for as long as it runs. The intervals are cut down
# on the command line -- the image's own start period is five minutes, which is
# a clone of a large repository over a slow line and far more than a smoke test
# may take.
info "AC (#25): a container that never starts tmux ends unhealthy"
docker rm -f "$NOSESSION" >/dev/null 2>&1
docker run -d --name "$NOSESSION" \
  --entrypoint sh \
  --health-start-period=2s --health-interval=1s --health-retries=2 \
  "$IMAGE" -c 'sleep 300' >/dev/null
nosession=''
for _ in $(seq 1 30); do
  nosession="$(docker inspect -f '{{.State.Health.Status}}' "$NOSESSION" 2>/dev/null | tr -d '\r')"
  [[ "$nosession" == 'unhealthy' ]] && break
  sleep 1
done
check "Health gives up rather than staying on start-up forever" "unhealthy" "$nosession"
docker rm -f "$NOSESSION" >/dev/null 2>&1

info "AC 2: runs as non-root"
check "User is 'claude'" "claude" "$(dexec id -un 2>/dev/null | tr -d '\r')"
check "UID is not 0" "1001" "$(dexec id -u 2>/dev/null | tr -d '\r')"
check "Working directory is owned by the user" "claude" \
  "$(dexec stat -c '%U' /workspace 2>/dev/null | tr -d '\r')"

# ------------------------------------------------------- AC (#9): egress firewall
info "AC (#9): the container reaches whitelisted domains and no others"
check "Firewall reports itself active" "active" \
  "$(dexec head -1 /run/claudops-firewall.state 2>/dev/null | tr -d '\r')"
check "OUTPUT policy is DROP" "DROP" \
  "$(docker exec -u root "$CONTAINER" \
      sh -c "iptables -n -L OUTPUT | sed -n '1s/.*policy \([A-Z]*\).*/\1/p'" 2>/dev/null | tr -d '\r')"
check "A whitelisted GitHub host is reachable" "0" \
  "$(dexec curl -sS --max-time 15 -o /dev/null https://api.github.com/zen >/dev/null 2>&1; echo $?)"
check "api.anthropic.com is reachable" "0" \
  "$(dexec curl -sS --max-time 15 -o /dev/null https://api.anthropic.com/ >/dev/null 2>&1; echo $?)"
check "DNS still resolves" "0" \
  "$(dexec getent ahostsv4 registry.npmjs.org >/dev/null 2>&1; echo $?)"

blocked_rc="$(dexec curl -sS --max-time 5 -o /dev/null https://example.com >/dev/null 2>&1; echo $?)"
if [[ "$blocked_rc" != "0" ]]; then
  ok "A host that is not whitelisted is refused (curl exit $blocked_rc)"
else
  bad "example.com was reachable -- the firewall is not filtering"
fi

# The Anthropic reference whitelists the whole host /24, which here is the docker
# bridge: the claudops API on the gateway and every neighbouring instance
# (knowledge/do-not-whitelist-the-docker-bridge.md).
gateway="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "$CONTAINER" | tr -d '\r')"
check "The docker bridge gateway is not whitelisted" "1" \
  "$(docker exec -u root "$CONTAINER" ipset test claudops-allow "$gateway" >/dev/null 2>&1; echo $?)"
gateway_rc="$(dexec curl -sS --max-time 4 -o /dev/null "http://${gateway}:8080/" >/dev/null 2>&1; echo $?)"
if [[ "$gateway_rc" != "0" ]]; then
  ok "The claudops server's own port on the gateway is unreachable (curl exit $gateway_rc)"
else
  bad "The container reached the docker bridge gateway"
fi

# ------------------------------------------- AC (#17): the one deliberate hole
# The status listener is the single address:port an instance may reach on the
# host, and it is a rule rather than an ipset entry because the set matches an
# address and the API sits on the same one. Both halves are asserted: that the
# rule is there, and -- above -- that the API's port on the same gateway still
# is not.
info "AC (#17): the container may reach the status port and nothing else on the host"
check "The status port is allowed on the gateway" "0" \
  "$(docker exec -u root "$CONTAINER" \
      iptables -C CLAUDOPS-EGRESS -d "$gateway" -p tcp --dport "$STATUS_PORT" -j ACCEPT \
      >/dev/null 2>&1; echo $?)"
check "No rule opens the API's port on the same address" "1" \
  "$(docker exec -u root "$CONTAINER" \
      iptables -C CLAUDOPS-EGRESS -d "$gateway" -p tcp --dport 8080 -j ACCEPT \
      >/dev/null 2>&1; echo $?)"
check "The firewall says which endpoint it opened" "1" \
  "$(docker logs "$CONTAINER" 2>&1 | grep -c "status endpoint allowed: $gateway:$STATUS_PORT" | tr -d '\r')"

info "AC (#17): Claude Code is configured to report what it is doing"
for event in UserPromptSubmit Notification Stop SessionEnd; do
  check "$event runs claudops-status" "/usr/local/bin/claudops-status" \
    "$(dexec jq -r ".hooks.${event}[0].hooks[0].command" \
        /home/claude/.claude/settings.json 2>/dev/null | tr -d '\r')"
done

# Three ways a hook can go wrong inside a container, and none of them may reach
# the session: stdout is added to the conversation as context on
# UserPromptSubmit, and a non-zero exit there erases what the user typed. The
# server is not listening in this run, so this is the failing path throughout.
info "AC (#17): a hook that cannot report is silent and successful anyway"
hook_out="$(dexec sh -c \
  'printf %s "{\"hook_event_name\":\"UserPromptSubmit\"}" | /usr/local/bin/claudops-status' 2>&1)"
check "It prints nothing, not even an error" "" "$(tr -d '\r' <<<"$hook_out")"
check "It exits 0 with no server there" "0" \
  "$(dexec sh -c 'printf %s "{\"hook_event_name\":\"Stop\"}" | /usr/local/bin/claudops-status' \
      >/dev/null 2>&1; echo $?)"
check "It exits 0 on stdin that is not JSON" "0" \
  "$(dexec sh -c 'printf %s "not json" | /usr/local/bin/claudops-status' >/dev/null 2>&1; echo $?)"
check "It exits 0 with no endpoint configured at all" "0" \
  "$(docker exec -e CLAUDOPS_STATUS_TOKEN= -e CLAUDOPS_STATUS_PORT= "$CONTAINER" \
      sh -c 'printf %s "{\"hook_event_name\":\"Stop\"}" | /usr/local/bin/claudops-status' \
      >/dev/null 2>&1; echo $?)"

info "AC (#9): the agent cannot widen its own whitelist"
check "Re-running the firewall is refused" "3" \
  "$(dexec sudo -n /usr/local/bin/init-firewall.sh >/dev/null 2>&1; echo $?)"
check "The whitelist survived the refused re-run" "0" \
  "$(dexec curl -sS --max-time 15 -o /dev/null https://api.github.com/zen >/dev/null 2>&1; echo $?)"
check "A re-run with its own FIREWALL_ALLOW is refused too" "3" \
  "$(docker exec -e FIREWALL_ALLOW=evil.example "$CONTAINER" \
      sudo -n /usr/local/bin/init-firewall.sh >/dev/null 2>&1; echo $?)"
check "sudo grants nothing but that one script" "1" \
  "$(dexec sudo -n /bin/sh -c id >/dev/null 2>&1; echo $?)"
check "The script takes no arguments through sudo" "1" \
  "$(dexec sudo -n /usr/local/bin/init-firewall.sh --allow evil.example >/dev/null 2>&1; echo $?)"

iptables_rc="$(dexec iptables -L >/dev/null 2>&1; echo $?)"
if [[ "$iptables_rc" != "0" ]]; then
  ok "The unprivileged user cannot run iptables itself (exit $iptables_rc)"
else
  bad "iptables works as 'claude' -- the capability leaked"
fi

info "AC (#9): without NET_ADMIN the container withholds Claude"
docker rm -f "$NOCAP" >/dev/null 2>&1
docker run -d --name "$NOCAP" -e REPO_URL="$TEST_REPO" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NOCAP" tmux has-session -t main >/dev/null 2>&1 && break
  sleep 1
done
# `unfiltered`, not `failed`: setting a policy is itself an iptables call, so
# without the capability the container cannot even be sealed -- and it says so
# rather than claim a seal it does not have.
check "State reports that egress is not filtered" "unfiltered" \
  "$(docker exec "$NOCAP" head -1 /run/claudops-firewall.state 2>/dev/null | tr -d '\r')"
check "The session still comes up for diagnosis" "0" \
  "$(docker exec "$NOCAP" tmux has-session -t main >/dev/null 2>&1; echo $?)"
check "Claude Code was withheld" "0" \
  "$(docker exec "$NOCAP" pgrep -fc 'claude' 2>/dev/null | tr -d '\r')"
check "The pane says why" "0" \
  "$(docker exec "$NOCAP" sh -c \
      "tmux capture-pane -p -t main | grep -q 'egress firewall did not come up'" >/dev/null 2>&1; echo $?)"
docker rm -f "$NOCAP" >/dev/null 2>&1

# ---------------------------------------------- AC: detach / reattach
info "AC 3: tmux detach/reattach, Claude keeps running"
check "history-limit is raised" "100000" \
  "$(dexec tmux show-options -gv history-limit 2>/dev/null | tr -d '\r')"

pid_before="$(dexec tmux display-message -p -t main:0.0 '#{pane_pid}' 2>/dev/null | tr -d '\r')"

# Write the marker into a separate window, without typing into the Claude TUI.
dexec tmux new-window -t main -n scrollback -d 'bash' >/dev/null 2>&1
sleep 1
dexec tmux send-keys -t main:scrollback "echo $MARKER" Enter >/dev/null 2>&1
sleep 1

# Attach inside a pseudo TTY in the container (independent of the host
# terminal). TERM is set explicitly, just like a real client would.
attach() {
  docker exec -d -e TERM=xterm-256color "$CONTAINER" \
    script -qc 'tmux attach -t main' /dev/null >/dev/null 2>&1
}

attach
sleep 3
client_term="$(dexec tmux list-clients -t main -F '#{client_termname}' 2>/dev/null | tr -d '\r')"
if [[ -n "$client_term" ]]; then
  ok "Client is attached to the session (TERM=$client_term)"
else
  bad "No attached client"
fi

# Simulate a dropped connection
dexec pkill -f 'tmux attach' >/dev/null 2>&1
sleep 2
check "No client left after the drop" "0" \
  "$(dexec tmux list-clients -t main 2>/dev/null | grep -c . | tr -d '\r')"
check "Session stays alive" "0" "$(dexec tmux has-session -t main >/dev/null 2>&1; echo $?)"
check "Claude pane has the same PID" "$pid_before" \
  "$(dexec tmux display-message -p -t main:0.0 '#{pane_pid}' 2>/dev/null | tr -d '\r')"

if dexec tmux capture-pane -p -S - -t main:scrollback 2>/dev/null | grep -q "$MARKER"; then
  ok "Scrollback survives the reattach"
else
  bad "Marker not in the scrollback"
fi

# Reattaching must be possible again
attach
sleep 3
reattached="$(dexec tmux list-clients -t main 2>/dev/null | grep -c . | tr -d '\r')"
if [[ "${reattached:-0}" -ge 1 ]]; then
  ok "Reattach works"
else
  bad "Reattach failed"
fi
dexec pkill -f 'tmux attach' >/dev/null 2>&1

# ------------------------------------------------------- credential helper
info "Credential helper: token stays out of config and remote"
check "No token in the remote URL" "0" \
  "$(dexec git -C "$REPO_DIR" remote -v 2>/dev/null | grep -c '@github.com' | tr -d '\r')"
check "credential.helper points at claudops" "claudops" \
  "$(dexec git config --global --get credential.helper 2>/dev/null | tr -d '\r')"
check "Matching host receives the token" "password=s3cret" \
  "$(docker exec -e GIT_TOKEN=s3cret -e GIT_TOKEN_HOST=github.com "$CONTAINER" \
      sh -c 'printf "protocol=https\nhost=github.com\n\n" | git-credential-claudops get' \
      2>/dev/null | grep '^password=' | tr -d '\r')"
check "Foreign host receives nothing" "" \
  "$(docker exec -e GIT_TOKEN=s3cret -e GIT_TOKEN_HOST=github.com "$CONTAINER" \
      sh -c 'printf "protocol=https\nhost=evil.example\n\n" | git-credential-claudops get' \
      2>/dev/null | tr -d '\r')"
check "Without GIT_TOKEN nobody receives anything" "" \
  "$(docker exec -e GIT_TOKEN= "$CONTAINER" \
      sh -c 'printf "protocol=https\nhost=github.com\n\n" | git-credential-claudops get' \
      2>/dev/null | tr -d '\r')"

# ------------------------------------------------- AC (#16): model and effort
info "AC (#16): the container runs Claude Code at the chosen model and effort"

# The pane command is `claude <args>`, so the arguments are on the process --
# which is the only place that can prove the flags actually arrived. Several
# processes carry them: the shell tmux started, the `claude` wrapper and the
# node process behind it, hence "at least one" rather than a count.
claude_args() { dexec pgrep -af 'claude' 2>/dev/null | tr -d '\r'; }

# has_arg <description> <argument> -- present at least once
has_arg() {
  local found; found="$(claude_args | grep -c -- "$2")"
  if [[ "${found:-0}" -ge 1 ]]; then
    ok "$1"
  else
    bad "$1 (no process carries '$2')"
    claude_args | sed 's/^/        /'
  fi
}

# has_no_arg <description> <argument> -- present nowhere
has_no_arg() {
  local found; found="$(claude_args | grep -c -- "$2")"
  if [[ "${found:-0}" -eq 0 ]]; then
    ok "$1"
  else
    bad "$1 ('$2' is still on the command line)"
    claude_args | sed 's/^/        /'
  fi
}

has_arg "Started with --model $START_MODEL" "--model $START_MODEL"
has_arg "Started with --effort $START_EFFORT" "--effort $START_EFFORT"

# What claudops writes when the model is switched from the UI. The file wins
# over the environment on the next start, and an *empty* one means "no flag" --
# a removed file would fall back to the environment, which still says haiku.
info "AC (#16): the override file survives a restart, the environment does not win"
dexec sh -c 'mkdir -p ~/.claudops && printf %s "$1" > ~/.claudops/model && printf %s "" > ~/.claudops/effort' \
  sh "$SWITCHED_MODEL" >/dev/null 2>&1 || bad "could not write the override files"

docker restart "$CONTAINER" >/dev/null 2>&1 || bad "docker restart"
for _ in $(seq 1 90); do
  dexec pgrep -f 'claude' >/dev/null 2>&1 && break
  sleep 1
done

has_arg "Restart uses the override" "--model $SWITCHED_MODEL"
has_no_arg "CLAUDE_MODEL from the create no longer wins" "--model $START_MODEL"
has_no_arg "The empty override file means no --effort at all" "--effort"

# ------------------------------------------------------------ docker stop
info "Clean stop (SIGTERM)"
stop_start=$(date +%s)
docker stop "$CONTAINER" >/dev/null 2>&1
stop_took=$(( $(date +%s) - stop_start ))
if [[ "$stop_took" -lt 10 ]]; then
  ok "Container stops in ${stop_took}s (no SIGKILL timeout)"
else
  bad "Container took ${stop_took}s -- SIGTERM is not being handled"
fi

info "Result: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
