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
TEST_REPO="${TEST_REPO:-https://github.com/dominikz98/claudops.git}"
TEST_BRANCH="${TEST_BRANCH:-main}"
REPO_DIR="/workspace/claudops"
MARKER="CLAUDOPS_SCROLLBACK_MARKER"

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

cleanup() { docker rm -f "$CONTAINER" "$NOCAP" >/dev/null 2>&1; }
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
