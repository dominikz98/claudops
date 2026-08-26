#!/usr/bin/env bash
# claudops-base entrypoint
#
# 1. Install the egress firewall (default-deny plus a whitelist)
# 2. Configure git (credential helper for GIT_TOKEN)
# 3. Clone REPO_URL into $WORKSPACE_DIR/<repo-name>
# 4. Start Claude Code in a detached tmux session
# 5. Watch over the session as PID 1 until it ends or SIGTERM arrives
#
# The session is started *detached* on purpose: the claudops server starts the
# container without a TTY and attaches later via `docker exec ... tmux attach`.
set -uo pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
TMUX_SESSION="${TMUX_SESSION:-main}"
REPO_BRANCH="${REPO_BRANCH:-main}"
CLAUDE_ARGS="${CLAUDE_ARGS:-}"
FIREWALL_MODE="${FIREWALL_MODE:-enforce}"
FIREWALL_SCRIPT='/usr/local/bin/init-firewall.sh'
FIREWALL_STATE='/run/claudops-firewall.state'

log() { printf '[claudops] %s\n' "$*"; }

# Strip credentials from URLs so no token ends up in the log.
redact() { sed -E 's#://[^/@]*@#://***@#g' <<<"$1"; }

host_from_url() {
  local rest="${1#*://}"
  rest="${rest#*@}"
  printf '%s' "${rest%%/*}"
}

repo_dir_for() {
  local name="${1%/}"
  name="${name##*/}"
  name="${name%.git}"
  [[ -n "$name" ]] || name="repo"
  printf '%s/%s' "$WORKSPACE_DIR" "$name"
}

# Egress is default-deny. iptables needs CAP_NET_ADMIN in its *effective* set,
# and a uid-1001 process holds no capabilities even when the container was
# started with --cap-add=NET_ADMIN -- hence the single NOPASSWD sudo entry,
# scoped to this one path with no arguments allowed
# (/etc/sudoers.d/claudops-firewall).
setup_firewall() {
  if [[ "$FIREWALL_MODE" == 'off' ]]; then
    log 'WARNING: FIREWALL_MODE=off -- this container has unrestricted egress.'
    return 0
  fi

  command -v sudo >/dev/null 2>&1 || {
    log 'ERROR: sudo is missing from the image.'
    return 1
  }

  log 'Installing the egress firewall.'
  # -n so a broken sudoers fails at once instead of waiting for a password on a
  # stdin that is not a terminal.
  sudo -n "$FIREWALL_SCRIPT" && return 0

  # Deliberately says nothing about what the egress now is: the script seals the
  # namespace where it can, and without CAP_NET_ADMIN it cannot even do that.
  # Its state file is the one place that knows which of the two happened.
  log "ERROR: the egress firewall did not come up -- see $FIREWALL_STATE."
  return 1
}

configure_git() {
  git config --global credential.helper claudops
  git config --global init.defaultBranch main
  [[ -n "${GIT_USER_NAME:-}" ]] && git config --global user.name "$GIT_USER_NAME"
  [[ -n "${GIT_USER_EMAIL:-}" ]] && git config --global user.email "$GIT_USER_EMAIL"
  return 0
}

clone_repo() {
  local url="$1" target="$2"

  if [[ -d "$target/.git" ]]; then
    log "Repo already present in $target -- skipping clone."
    return 0
  fi

  log "Cloning $(redact "$url") (branch $REPO_BRANCH) into $target"
  if git clone --branch "$REPO_BRANCH" "$url" "$target"; then
    log "Clone succeeded."
    return 0
  fi

  # No abort here: a dead container would no longer be reachable through the
  # terminal bridge, and that is exactly when you want to look inside (wrong
  # PAT, wrong branch).
  log "ERROR: clone failed -- the session starts in $WORKSPACE_DIR anyway."
  return 1
}

shutdown() {
  log "Signal received -- shutting down the tmux server."
  tmux kill-server 2>/dev/null
  exit 0
}

main() {
  local start_dir="$WORKSPACE_DIR" target pane_cmd
  local firewall_ok=1

  # Before anything touches the network: the clone has to be subject to the
  # whitelist too, and a failed firewall must not be discovered by the agent.
  setup_firewall || firewall_ok=0

  configure_git

  if [[ -n "${REPO_URL:-}" ]]; then
    # Hand the token only to the host of the project repo.
    export GIT_TOKEN_HOST="${GIT_TOKEN_HOST:-$(host_from_url "$REPO_URL")}"
    target="$(repo_dir_for "$REPO_URL")"
    if clone_repo "$REPO_URL" "$target"; then
      start_dir="$target"
    fi
  else
    log "No REPO_URL set -- starting without a repo in $WORKSPACE_DIR."
  fi

  trap shutdown TERM INT

  # `exec bash -l` in both branches keeps the pane open when what ran before it
  # ends -- otherwise the session disappears and the container dies on the first
  # /exit.
  if [[ "$firewall_ok" -eq 1 ]]; then
    pane_cmd="claude ${CLAUDE_ARGS}; exec bash -l"
  else
    # Fail closed on the network, stay reachable for diagnosis: the same
    # reasoning as a failed clone (knowledge/failed-clone-must-not-abort.md),
    # with the opposite conclusion for the agent. Claude Code started with
    # --dangerously-skip-permissions and unrestricted egress is exactly what the
    # firewall exists to prevent, so it is withheld -- but the session still
    # comes up, because a container nobody can attach to cannot be diagnosed.
    log 'ERROR: Claude Code is NOT started -- no egress firewall.'
    pane_cmd="printf '%s\n' \
      '### claudops: the egress firewall did not come up.' \
      '### Claude Code was not started.' \
      '### cat $FIREWALL_STATE -- \"failed\" means egress is sealed to loopback,' \
      '### \"unfiltered\" means it is NOT restricted at all (missing NET_ADMIN).' \
      ; exec bash -l"
  fi

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "tmux session '$TMUX_SESSION' is already running."
  else
    log "Starting the tmux session '$TMUX_SESSION' (cwd: $start_dir)."
    tmux new-session -d -s "$TMUX_SESSION" -c "$start_dir" "$pane_cmd"
  fi

  while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
    sleep 5 &
    wait $!
  done

  log "tmux session ended -- container is shutting down."
}

main "$@"
