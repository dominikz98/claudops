# Glossary

| Term | Meaning |
| --- | --- |
| **Instance** | One Docker container running exactly one Claude Code session in a tmux session named `main`. Created from a project, disposable. |
| **Project** | The template an instance is created from: repository URL, branch, environment building blocks and a git credential. Planned (#6). |
| **Base image** | `claudops-base` -- Node, Claude Code CLI, git, tmux, the non-root user `claude` and the entrypoint. Every instance image derives from it. |
| **Project image** | `claudops-project-<id>` -- the base image plus the environment building blocks of one project, prebuilt. Planned (#7). |
| **Building block** | An optional layer in a project image, e.g. dotnet SDK or Playwright with Chromium. Planned (#7). |
| **Bridge / terminal bridge** | The WebSocket endpoint that pipes a container TTY to the browser console. Planned (#4). |
| **Reconcile** | The startup pass that compares Docker reality against the database and removes or marks the leftovers. Planned (#8). |
| **claudops label** | `claudops.instance=<id>`, set on every resource an instance owns, so cleanup can find them all. |
| **Instance status** | Read from the Docker API on every request, never stored: the Docker state (`running`, `exited`, `created`, …) or `missing` when the server has a row and Docker has no container. |
| **Instance id** | The short id the server generates. It names the container (`claudops-<id>`) and is the value of the claudops label. |
| **NUC** | The Intel NUC running Ubuntu and Docker that hosts all of this. |
