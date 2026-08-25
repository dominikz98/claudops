# Glossary

| Term | Meaning |
| --- | --- |
| **Instance** | One Docker container running exactly one Claude Code session in a tmux session named `main`. Created from a project, disposable. |
| **Project** | The template an instance is created from: repository URL, branch, environment building blocks and a git credential. Its name is unique, and it cannot be deleted while instances point at it. |
| **Project PAT** | The GitHub token of a project, stored encrypted with `CLAUDOPS_SECRET_KEY`. Write-only: the API reports whether one is set, never its value. |
| **Base image** | `claudops-base` -- Node, Claude Code CLI, git, tmux, the non-root user `claude` and the entrypoint. Every instance image derives from it. |
| **Project image** | `claudops-project-<id>` -- the base image plus the environment building blocks of one project, prebuilt. Planned (#7). |
| **Building block** | An optional layer in a project image, e.g. dotnet SDK or Playwright with Chromium. Set on a project today, built into an image with #7. |
| **Bridge / terminal bridge** | The WebSocket endpoint `/instances/:id/terminal` that pipes a container TTY to the browser console. One exec and one tmux client per connection. |
| **Web UI** | The Vite SPA in `web/`, served by the server itself on the same port: instance list, projects page and one console per instance. Its own routes live in the URL fragment (`#/projects`, `#/i/<id>`), because the path belongs to the REST API. |
| **Reconcile** | The startup pass that compares Docker reality against the database and removes or marks the leftovers. Planned (#8). |
| **claudops label** | `claudops.instance=<id>`, set on every resource an instance owns, so cleanup can find them all. |
| **Instance status** | Read from the Docker API on every request, never stored: the Docker state (`running`, `exited`, `created`, …) or `missing` when the server has a row and Docker has no container. |
| **Instance id** | The short id the server generates. It names the container (`claudops-<id>`) and is the value of the claudops label. |
| **NUC** | The Intel NUC running Ubuntu and Docker that hosts all of this. |
