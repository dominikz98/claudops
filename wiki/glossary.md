# Glossary

| Term | Meaning |
| --- | --- |
| **Instance** | One Docker container running exactly one Claude Code session in a tmux session named `main`. Created from a project, capped in CPU and memory, stoppable, disposable. |
| **Project** | The template an instance is created from: repository URL, branch, environment building blocks and a git credential. Its name is unique, and it cannot be deleted while instances point at it. |
| **Project PAT** | The GitHub token of a project, stored encrypted with `CLAUDOPS_SECRET_KEY`. Write-only: the API reports whether one is set, never its value. |
| **Base image** | `claudops-base` -- Node, Claude Code CLI, git, tmux, the non-root user `claude` and the entrypoint. Every instance image derives from it. |
| **Project image** | `claudops-project-<id>` -- the base image plus the environment building blocks of one project, prebuilt by the server from `docker/project/Dockerfile`. Instances start from it. Tagged after the project id, so a rename keeps the image. |
| **Building block** | An optional layer in a project image: dotnet SDK, or Playwright with Chromium. Ticked on the project, passed to the build as an arg. |
| **Image status** | Where a project's image stands: `pending` (queued), `building`, `ready`, `failed`. Only `ready` allows an instance to be created -- the environment is prebuilt, so there is nothing to fall back to. |
| **Build log** | The daemon's output from the last build of a project image, kept on the project (last 64 KiB) and readable at `GET /projects/:id/build-log`. The only trace a failed build leaves. |
| **Bridge / terminal bridge** | The WebSocket endpoint `/instances/:id/terminal` that pipes a container TTY to the browser console. One exec and one tmux client per connection. |
| **Web UI** | The Vite SPA in `web/`, served by the server itself on the same port: instance list, projects page and one console per instance. Its own routes live in the URL fragment (`#/projects`, `#/i/<id>`), because the path belongs to the REST API. |
| **Reconcile** | The pass that runs once at every server start: it removes the labelled containers and volumes no instance claims, and forgets the container of an instance Docker no longer has -- which is what makes that instance report `missing`. Never periodic. |
| **Instance limits** | The CPU and memory ceiling every instance container is created with, `CLAUDOPS_INSTANCE_CPUS` and `CLAUDOPS_INSTANCE_MEMORY`, by default two cores and four gigabytes with swap capped at the memory limit. |
| **claudops label** | `claudops.instance=<id>` on every resource an instance owns, `claudops.project=<id>` on a project image, so cleanup can find them all -- and tell them from anything built by hand. |
| **Instance status** | Read from the Docker API on every request, never stored: the Docker state (`running`, `exited`, `created`, …) or `missing` when the server has a row and Docker has no container. |
| **Instance id** | The short id the server generates. It names the container (`claudops-<id>`) and is the value of the claudops label. |
| **NUC** | The Intel NUC running Ubuntu and Docker that hosts all of this. |
