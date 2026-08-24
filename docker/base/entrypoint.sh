#!/usr/bin/env bash
# claudops-base entrypoint
#
# 1. Configure git (credential helper for GIT_TOKEN)
# 2. Clone REPO_URL into $WORKSPACE_DIR/<repo-name>
# 3. Start Claude Code in a detached tmux session
# 4. Watch over the session as PID 1 until it ends or SIGTERM arrives
#
# The session is started *detached* on purpose: the claudops server starts the
# container without a TTY and attaches later via `docker exec ... tmux attach`.
set -uo pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
TMUX_SESSION="${TMUX_SESSION:-main}"
REPO_BRANCH="${REPO_BRANCH:-main}"
CLAUDE_ARGS="${CLAUDE_ARGS:-}"

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
  local start_dir="$WORKSPACE_DIR" target

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

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "tmux session '$TMUX_SESSION' is already running."
  else
    log "Starting Claude Code in tmux session '$TMUX_SESSION' (cwd: $start_dir)."
    # `exec bash -l` keeps the pane open when Claude exits -- otherwise the
    # session disappears and the container dies on the first /exit.
    tmux new-session -d -s "$TMUX_SESSION" -c "$start_dir" \
      "claude ${CLAUDE_ARGS}; exec bash -l"
  fi

  while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
    sleep 5 &
    wait $!
  done

  log "tmux session ended -- container is shutting down."
}

main "$@"
