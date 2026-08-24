# tmux attach through docker exec needs TERM in the image

**Fact.** `claudops-base` sets `ENV TERM=xterm-256color`.

**Why.** A `docker exec` without `-t` passes no `TERM`, and `tmux attach` then
aborts with "terminal does not support clear". The terminal bridge execs exactly
that way -- TTY on the exec, but the environment comes from the image. Clients
that send their own `TERM` override it, so the default costs nothing.

**Applies to.** `docker/base/Dockerfile`, issue #4.
