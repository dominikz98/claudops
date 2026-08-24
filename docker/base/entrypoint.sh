#!/usr/bin/env bash
# claudops-base Entrypoint
#
# 1. Git konfigurieren (Credential-Helper für GIT_TOKEN)
# 2. REPO_URL nach $WORKSPACE_DIR/<repo-name> klonen
# 3. Claude Code in einer detached tmux-Session starten
# 4. Als PID 1 über der Session wachen, bis sie endet oder SIGTERM kommt
#
# Die Session wird bewusst *detached* gestartet: der claudops-Server startet den
# Container ohne TTY und hängt sich später per `docker exec ... tmux attach` dran.
set -uo pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
TMUX_SESSION="${TMUX_SESSION:-main}"
REPO_BRANCH="${REPO_BRANCH:-main}"
CLAUDE_ARGS="${CLAUDE_ARGS:-}"

log() { printf '[claudops] %s\n' "$*"; }

# Credentials aus URLs entfernen, damit kein Token im Log landet.
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
    log "Repo liegt bereits in $target — Clone übersprungen."
    return 0
  fi

  log "Klone $(redact "$url") (Branch $REPO_BRANCH) nach $target"
  if git clone --branch "$REPO_BRANCH" "$url" "$target"; then
    log "Clone erfolgreich."
    return 0
  fi

  # Kein Abbruch: ein toter Container wäre per Terminal-Bridge nicht mehr
  # erreichbar, und genau dann will man nachsehen (falscher PAT, falscher Branch).
  log "FEHLER: Clone fehlgeschlagen — die Session startet trotzdem in $WORKSPACE_DIR."
  return 1
}

shutdown() {
  log "Signal empfangen — beende tmux-Server."
  tmux kill-server 2>/dev/null
  exit 0
}

main() {
  local start_dir="$WORKSPACE_DIR" target

  configure_git

  if [[ -n "${REPO_URL:-}" ]]; then
    # Das Token nur an den Host des Projekt-Repos ausliefern.
    export GIT_TOKEN_HOST="${GIT_TOKEN_HOST:-$(host_from_url "$REPO_URL")}"
    target="$(repo_dir_for "$REPO_URL")"
    if clone_repo "$REPO_URL" "$target"; then
      start_dir="$target"
    fi
  else
    log "Kein REPO_URL gesetzt — starte ohne Repo in $WORKSPACE_DIR."
  fi

  trap shutdown TERM INT

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "tmux-Session '$TMUX_SESSION' läuft bereits."
  else
    log "Starte Claude Code in tmux-Session '$TMUX_SESSION' (cwd: $start_dir)."
    # `exec bash -l` hält den Pane offen, wenn Claude beendet wird — sonst
    # fällt die Session weg und der Container stirbt beim ersten /exit.
    tmux new-session -d -s "$TMUX_SESSION" -c "$start_dir" \
      "claude ${CLAUDE_ARGS}; exec bash -l"
  fi

  while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
    sleep 5 &
    wait $!
  done

  log "tmux-Session beendet — Container fährt runter."
}

main "$@"
