# claudops-base -- shared base image for all Claude Code instances.
# Project images (#7) build on top of it via `FROM claudops-base`.
FROM node:22-bookworm

# Version can be pinned: --build-arg CLAUDE_CODE_VERSION=1.2.3
ARG CLAUDE_CODE_VERSION=latest
ARG USER_NAME=claude
ARG USER_UID=1001
ARG USER_GID=1001

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      procps \
      tmux \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# Non-root user. UID 1000 is already taken by `node` in the node image.
RUN groupadd --gid "${USER_GID}" "${USER_NAME}" \
 && useradd --uid "${USER_UID}" --gid "${USER_GID}" --create-home --shell /bin/bash "${USER_NAME}"

COPY entrypoint.sh git-credential-claudops /usr/local/bin/
COPY tmux.conf /etc/claudops/tmux.conf

# Line endings and the exec bit depend on the build host's checkout, so set
# them explicitly here.
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/git-credential-claudops \
 && ln -s /etc/claudops/tmux.conf "/home/${USER_NAME}/.tmux.conf" \
 && chown -h "${USER_UID}:${USER_GID}" "/home/${USER_NAME}/.tmux.conf"

# Without TERM a `tmux attach` from a `docker exec` without -t fails with
# "terminal does not support clear". Clients with their own TERM override this.
ENV TERM=xterm-256color \
    WORKSPACE_DIR=/workspace \
    REPO_BRANCH=main \
    TMUX_SESSION=main \
    CLAUDE_ARGS=--dangerously-skip-permissions \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN mkdir -p "${WORKSPACE_DIR}" && chown "${USER_UID}:${USER_GID}" "${WORKSPACE_DIR}"

USER ${USER_NAME}
WORKDIR ${WORKSPACE_DIR}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
