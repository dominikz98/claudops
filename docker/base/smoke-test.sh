#!/usr/bin/env bash
# Smoke-Test für claudops-base: prüft die Akzeptanzkriterien aus Issue #2
# gegen einen echt laufenden Container.
#
#   ./docker/base/smoke-test.sh              # baut das Image und testet
#   SKIP_BUILD=1 ./docker/base/smoke-test.sh # nutzt ein vorhandenes Image
#
# Ein gesetztes CLAUDE_CODE_OAUTH_TOKEN wird durchgereicht, ist aber nicht nötig.
set -uo pipefail

# Git-Bash/MSYS wandelt Argumente wie "/workspace/..." sonst in Windows-Pfade um
# und die Container-Pruefungen liefen ins Leere. Unter Linux wirkungslos.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-claudops-base:test}"
CONTAINER="${CONTAINER:-claudops-smoke}"
TEST_REPO="${TEST_REPO:-https://github.com/dominikz98/claudops.git}"
TEST_BRANCH="${TEST_BRANCH:-main}"
REPO_DIR="/workspace/claudops"
MARKER="CLAUDOPS_SCROLLBACK_MARKER"

pass=0
fail=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# check <beschreibung> <erwartet> <ist>
check() {
  if [[ "$2" == "$3" ]]; then
    ok "$1"
  else
    bad "$1 (erwartet: '$2', ist: '$3')"
  fi
}

dexec() { docker exec "$CONTAINER" "$@"; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

# ---------------------------------------------------------------- Build & Start
if [[ -z "${SKIP_BUILD:-}" ]]; then
  info "Image bauen ($IMAGE)"
  build_context="$SCRIPT_DIR"
  command -v cygpath >/dev/null 2>&1 && build_context="$(cygpath -w "$SCRIPT_DIR")"
  docker build -t "$IMAGE" "$build_context" || { bad "docker build"; exit 1; }
fi

info "Container starten"
cleanup
docker run -d --name "$CONTAINER" \
  -e REPO_URL="$TEST_REPO" \
  -e REPO_BRANCH="$TEST_BRANCH" \
  -e GIT_USER_NAME="claudops" \
  -e GIT_USER_EMAIL="claudops@example.invalid" \
  ${CLAUDE_CODE_OAUTH_TOKEN:+-e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"} \
  "$IMAGE" >/dev/null || { bad "docker run"; exit 1; }

# Auf Clone + Session warten
for _ in $(seq 1 60); do
  dexec tmux has-session -t main >/dev/null 2>&1 && break
  sleep 1
done

# ------------------------------------------------- AK: Repo geklont, non-root
info "AK 1: docker run klont das Repo und startet Claude Code in tmux"
check "Repo liegt in $REPO_DIR" "yes" \
  "$(dexec sh -c "[ -d $REPO_DIR/.git ] && echo yes || echo no" 2>/dev/null | tr -d '\r')"
check "Branch ist $TEST_BRANCH" "$TEST_BRANCH" \
  "$(dexec git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\r')"
check "tmux-Session 'main' existiert" "main" \
  "$(dexec tmux list-sessions -F '#{session_name}' 2>/dev/null | tr -d '\r')"

claude_procs="$(dexec pgrep -fc 'claude' 2>/dev/null | tr -d '\r')"
if [[ "${claude_procs:-0}" -ge 1 ]]; then
  ok "Claude-Code-Prozess läuft im Container ($claude_procs)"
else
  bad "Kein Claude-Code-Prozess gefunden — Pane-Inhalt:"
  dexec tmux capture-pane -p -t main:0.0 2>/dev/null | sed 's/^/        /'
fi
check "Claude-CLI ist installiert" "0" \
  "$(dexec claude --version >/dev/null 2>&1; echo $?)"

info "AK 2: Läuft als non-root"
check "Benutzer ist 'claude'" "claude" "$(dexec id -un 2>/dev/null | tr -d '\r')"
check "UID ist nicht 0" "1001" "$(dexec id -u 2>/dev/null | tr -d '\r')"
check "Arbeitsverzeichnis gehört dem User" "claude" \
  "$(dexec stat -c '%U' /workspace 2>/dev/null | tr -d '\r')"

# ---------------------------------------------- AK: Detach / Reattach
info "AK 3: tmux-Detach/-Reattach, Claude läuft weiter"
check "history-limit ist hochgesetzt" "100000" \
  "$(dexec tmux show-options -gv history-limit 2>/dev/null | tr -d '\r')"

pid_before="$(dexec tmux display-message -p -t main:0.0 '#{pane_pid}' 2>/dev/null | tr -d '\r')"

# Marker in ein separates Fenster schreiben, ohne im Claude-TUI zu tippen.
dexec tmux new-window -t main -n scrollback -d 'bash' >/dev/null 2>&1
sleep 1
dexec tmux send-keys -t main:scrollback "echo $MARKER" Enter >/dev/null 2>&1
sleep 1

# Attach in einer Pseudo-TTY im Container (unabhängig vom Host-Terminal).
# TERM wird explizit gesetzt, wie es auch ein echter Client tut.
attach() {
  docker exec -d -e TERM=xterm-256color "$CONTAINER" \
    script -qc 'tmux attach -t main' /dev/null >/dev/null 2>&1
}

attach
sleep 3
client_term="$(dexec tmux list-clients -t main -F '#{client_termname}' 2>/dev/null | tr -d '\r')"
if [[ -n "$client_term" ]]; then
  ok "Client hängt an der Session (TERM=$client_term)"
else
  bad "Kein angehängter Client"
fi

# Verbindungsabbruch simulieren
dexec pkill -f 'tmux attach' >/dev/null 2>&1
sleep 2
check "Nach Abbruch kein Client mehr" "0" \
  "$(dexec tmux list-clients -t main 2>/dev/null | grep -c . | tr -d '\r')"
check "Session lebt weiter" "0" "$(dexec tmux has-session -t main >/dev/null 2>&1; echo $?)"
check "Claude-Pane hat dieselbe PID" "$pid_before" \
  "$(dexec tmux display-message -p -t main:0.0 '#{pane_pid}' 2>/dev/null | tr -d '\r')"

if dexec tmux capture-pane -p -S - -t main:scrollback 2>/dev/null | grep -q "$MARKER"; then
  ok "Scrollback nach Reattach erhalten"
else
  bad "Marker nicht im Scrollback"
fi

# Reattach muss erneut möglich sein
attach
sleep 3
reattached="$(dexec tmux list-clients -t main 2>/dev/null | grep -c . | tr -d '\r')"
if [[ "${reattached:-0}" -ge 1 ]]; then
  ok "Reattach funktioniert"
else
  bad "Reattach fehlgeschlagen"
fi
dexec pkill -f 'tmux attach' >/dev/null 2>&1

# ------------------------------------------------------- Credential-Helper
info "Credential-Helper: Token bleibt aus Config und Remote heraus"
check "Kein Token in der Remote-URL" "0" \
  "$(dexec git -C "$REPO_DIR" remote -v 2>/dev/null | grep -c '@github.com' | tr -d '\r')"
check "credential.helper zeigt auf claudops" "claudops" \
  "$(dexec git config --global --get credential.helper 2>/dev/null | tr -d '\r')"
check "Passender Host bekommt das Token" "password=s3cret" \
  "$(docker exec -e GIT_TOKEN=s3cret -e GIT_TOKEN_HOST=github.com "$CONTAINER" \
      sh -c 'printf "protocol=https\nhost=github.com\n\n" | git-credential-claudops get' \
      2>/dev/null | grep '^password=' | tr -d '\r')"
check "Fremder Host bekommt nichts" "" \
  "$(docker exec -e GIT_TOKEN=s3cret -e GIT_TOKEN_HOST=github.com "$CONTAINER" \
      sh -c 'printf "protocol=https\nhost=evil.example\n\n" | git-credential-claudops get' \
      2>/dev/null | tr -d '\r')"
check "Ohne GIT_TOKEN bekommt niemand etwas" "" \
  "$(docker exec -e GIT_TOKEN= "$CONTAINER" \
      sh -c 'printf "protocol=https\nhost=github.com\n\n" | git-credential-claudops get' \
      2>/dev/null | tr -d '\r')"

# ------------------------------------------------------------ docker stop
info "Sauberer Stop (SIGTERM)"
stop_start=$(date +%s)
docker stop "$CONTAINER" >/dev/null 2>&1
stop_took=$(( $(date +%s) - stop_start ))
if [[ "$stop_took" -lt 10 ]]; then
  ok "Container stoppt in ${stop_took}s (kein SIGKILL-Timeout)"
else
  bad "Container brauchte ${stop_took}s — SIGTERM wird nicht verarbeitet"
fi

info "Ergebnis: $pass bestanden, $fail fehlgeschlagen"
[[ "$fail" -eq 0 ]]
