# claudops-base — gemeinsames Basisimage aller Claude-Code-Instanzen.
# Projekt-Images (#7) setzen mit `FROM claudops-base` darauf auf.
FROM node:22-bookworm

# Version pinbar: --build-arg CLAUDE_CODE_VERSION=1.2.3
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

# Non-root User. UID 1000 ist im node-Image schon von `node` belegt.
RUN groupadd --gid "${USER_GID}" "${USER_NAME}" \
 && useradd --uid "${USER_UID}" --gid "${USER_GID}" --create-home --shell /bin/bash "${USER_NAME}"

COPY entrypoint.sh git-credential-claudops /usr/local/bin/
COPY tmux.conf /etc/claudops/tmux.conf

# Zeilenenden/Exec-Bit hängen am Checkout des Build-Hosts, darum hier explizit.
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/git-credential-claudops \
 && ln -s /etc/claudops/tmux.conf "/home/${USER_NAME}/.tmux.conf" \
 && chown -h "${USER_UID}:${USER_GID}" "/home/${USER_NAME}/.tmux.conf"

# Ohne TERM scheitert ein `tmux attach` aus einem `docker exec` ohne -t an
# "terminal does not support clear". Clients mit eigenem TERM übersteuern das.
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
