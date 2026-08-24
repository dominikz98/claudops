# `claudops-base`

Gemeinsames Basisimage aller Claude-Code-Instanzen. Der Container klont beim Start
ein Repository und startet darin Claude Code in einer tmux-Session, an die sich der
claudops-Server später per `docker exec ... tmux attach` hängt.

Projekt-Images (Issue #7) setzen mit `FROM claudops-base` darauf auf.

## Bauen

```bash
docker build -t claudops-base docker/base
```

Optional die Claude-Code-Version pinnen:

```bash
docker build -t claudops-base --build-arg CLAUDE_CODE_VERSION=1.2.3 docker/base
```

## Starten

```bash
docker run -d --name claudops-demo \
  -e REPO_URL=https://github.com/dominikz98/claudops.git \
  -e REPO_BRANCH=main \
  -e GIT_TOKEN="$GITHUB_PAT" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  claudops-base
```

Konsole öffnen (bis die Terminal-Bridge aus #4 existiert):

```bash
docker exec -it claudops-demo tmux attach -t main
```

Detach mit `Ctrl-b d` — Claude läuft weiter, ein erneutes `attach` findet Sitzung
und Scrollback vor. Genauso verhält es sich, wenn die Verbindung einfach abbricht.

## Environment

| Variable | Default | Zweck |
| --- | --- | --- |
| `REPO_URL` | – | Repository, das nach `/workspace/<name>` geklont wird. Ohne Angabe startet die Session in `/workspace`. |
| `REPO_BRANCH` | `main` | Branch für den Clone. |
| `GIT_TOKEN` | – | PAT für private Repos. Wird über einen Credential-Helper aus der Env geliefert, landet also nie in `.git/config` oder `git remote -v`. |
| `GIT_TOKEN_HOST` | Host aus `REPO_URL` | Beschränkt, welchem Host der Helper das Token zeigt. |
| `GIT_USERNAME` | `x-access-token` | Benutzername zum Token (GitHub akzeptiert jeden Wert). |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | – | Commit-Identität für Claude. |
| `CLAUDE_CODE_OAUTH_TOKEN` | – | Auth für Claude Code (`claude setup-token`). Bewusst **kein** `ANTHROPIC_API_KEY` — der übersteuert die Subscription. |
| `CLAUDE_ARGS` | `--dangerously-skip-permissions` | Argumente für den `claude`-Start. Nur zulässig wegen der Container-Isolation. |
| `WORKSPACE_DIR` | `/workspace` | Basisverzeichnis für Klone. |
| `TMUX_SESSION` | `main` | Session-Name, an den sich die Bridge hängt. |

## Verhalten

- **Non-root:** alles läuft als `claude` (UID 1001; 1000 ist im `node`-Image belegt).
- **Fehlgeschlagener Clone bricht nicht ab.** Die tmux-Session startet trotzdem in
  `/workspace`, damit man sich per Konsole draufschalten und die Ursache ansehen
  kann (falscher PAT, falscher Branch). Ein toter Container wäre dafür unerreichbar.
- **Container-Restart auf gleichem Volume** überspringt den Clone, wenn das
  Zielverzeichnis schon ein Git-Repo ist.
- **`docker stop`** beendet den tmux-Server über SIGTERM sauber.
- **PID 1** ist der Entrypoint; er wacht über die Session und beendet sich, wenn
  diese endet.

## Test

```bash
./docker/base/smoke-test.sh
```

Baut das Image, fährt einen Container hoch und prüft die Akzeptanzkriterien aus
Issue #2 (Clone, non-root, Detach/Reattach mit Scrollback, laufender Claude-Prozess)
sowie das Verhalten des Credential-Helpers. `SKIP_BUILD=1` überspringt den Build.

## Nicht Teil dieses Images

- Egress-Firewall (`init-firewall.sh`, `NET_ADMIN`) und UI-Login → Issue #9
- CPU-/RAM-Limits und Recycling → Issue #8
- dotnet-/Playwright-Bausteine → Issue #7
