# claudops-base -- shared base image for all Claude Code instances.
# Project images (#7) build on top of it via `FROM claudops-base`.
FROM node:22-bookworm

# Version can be pinned: --build-arg CLAUDE_CODE_VERSION=1.2.3
ARG CLAUDE_CODE_VERSION=latest
ARG USER_NAME=claude
ARG USER_UID=1001
ARG USER_GID=1001

ENV DEBIAN_FRONTEND=noninteractive

# iptables, ipset and sudo are here for the egress firewall alone: iptables needs
# CAP_NET_ADMIN in its *effective* set, which a uid-1001 process never has even
# when the container was started with --cap-add=NET_ADMIN, so the entrypoint
# reaches it through the one scoped sudoers entry below
# (knowledge/iptables-needs-root-not-just-net-admin.md).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      iptables \
      ipset \
      jq \
      less \
      procps \
      sudo \
      tmux \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# Non-root user. UID 1000 is already taken by `node` in the node image.
RUN groupadd --gid "${USER_GID}" "${USER_NAME}" \
 && useradd --uid "${USER_UID}" --gid "${USER_GID}" --create-home --shell /bin/bash "${USER_NAME}"

COPY entrypoint.sh git-credential-claudops init-firewall.sh /usr/local/bin/
COPY tmux.conf /etc/claudops/tmux.conf
COPY firewall-allow.conf /etc/claudops/firewall-allow.d/00-base.conf

# Line endings and the exec bit depend on the build host's checkout, so set
# them explicitly here.
#
# 0500 for the firewall script: root-only, so the unprivileged agent cannot even
# read the logic of the one thing it is not allowed to re-run. The allow-list is
# world-readable so it can be inspected from the console, but root-owned so it
# cannot be appended to.
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/git-credential-claudops \
 && chmod 0500 /usr/local/bin/init-firewall.sh \
 && chmod 0755 /etc/claudops/firewall-allow.d \
 && chmod 0644 /etc/claudops/firewall-allow.d/00-base.conf \
 && ln -s /etc/claudops/tmux.conf "/home/${USER_NAME}/.tmux.conf" \
 && chown -h "${USER_UID}:${USER_GID}" "/home/${USER_NAME}/.tmux.conf"

# One command, no arguments, no password -- and nothing else. The trailing ""
# is sudoers for "only with no command line arguments at all", not a wildcard,
# so the whitelist cannot be widened through argv. The three variables come
# through instead, scoped to this one command.
#
# That is safe because of the sentinel, not because of the transport: the agent
# runs as `claude` too and may well try `sudo init-firewall.sh` with its own
# FIREWALL_ALLOW, and the script exits 3 on the existing CLAUDOPS-EGRESS chain
# before it reads a single variable. Reading PID 1's environment instead would
# need CAP_SYS_PTRACE, which Docker does not grant
# (knowledge/proc-environ-needs-cap-sys-ptrace.md).
#
# `claude` is deliberately not added to the sudo group. `visudo -cf` in the same
# layer turns a typo into a failed build rather than an image where sudo refuses
# everything.
RUN printf '%s\n' \
      '# claudops: the egress firewall, and nothing else.' \
      'Defaults!/usr/local/bin/init-firewall.sh env_keep += "REPO_URL FIREWALL_ALLOW FIREWALL_REFRESH_SECONDS"' \
      "${USER_NAME} ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh \"\"" \
      > /etc/sudoers.d/claudops-firewall \
 && chmod 0440 /etc/sudoers.d/claudops-firewall \
 && visudo -cf /etc/sudoers.d/claudops-firewall

# Without TERM a `tmux attach` from a `docker exec` without -t fails with
# "terminal does not support clear". Clients with their own TERM override this.
#
# LANG is what tells tmux its client can take UTF-8. Without it tmux replaces
# every multi-byte character with an underscore on the way out, which turns
# Claude's whole TUI into rows of "_" -- see
# knowledge/tmux-needs-a-utf8-client.md. C.UTF-8 is built into glibc, so this
# needs no locales package.
#
# The two CLAUDE_CODE_DISABLE_* switches keep hosts off the whitelist rather
# than on it: the Datadog telemetry intakes and the wildcard artifact host
# `*.frame.claudeusercontent.com`, which an ipset cannot express at all.
ENV TERM=xterm-256color \
    LANG=C.UTF-8 \
    WORKSPACE_DIR=/workspace \
    REPO_BRANCH=main \
    TMUX_SESSION=main \
    CLAUDE_ARGS=--dangerously-skip-permissions \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    FIREWALL_MODE=enforce \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CLAUDE_CODE_DISABLE_ARTIFACT=1

RUN mkdir -p "${WORKSPACE_DIR}" && chown "${USER_UID}:${USER_GID}" "${WORKSPACE_DIR}"

USER ${USER_NAME}

# Claude Code asks three questions on a first start, and a fresh container is
# always a first start: the theme picker, the trust prompt for the working
# directory, and the confirmation of --dangerously-skip-permissions. None of them
# can be answered from the instance list, so the console opens on a wizard
# instead of on Claude -- see
# knowledge/claude-onboarding-must-be-pre-seeded.md for what each flag settles.
#
# The trust entry covers WORKSPACE_DIR itself, which is where a container
# without a REPO_URL starts. It does *not* reach the clone below it: a git
# repository is its own trust root, so the entrypoint adds an entry for the
# directory it actually cloned into.
#
# Pre-accepting the bypass-permissions warning restates the decision from
# EPIC #1, it does not take a new one: the mode is defensible only inside this
# image's isolation and its egress whitelist, which is precisely what the
# warning asks an operator to confirm.
#
# 0600 because Claude keeps writing to this file at runtime and its own first
# start creates it that way.
RUN printf '%s' \
      '{"hasCompletedOnboarding":true,"theme":"dark",' \
      '"bypassPermissionsModeAccepted":true,' \
      "\"projects\":{\"${WORKSPACE_DIR}\":{\"hasTrustDialogAccepted\":true}}}" \
      > "/home/${USER_NAME}/.claude.json" \
 && chmod 0600 "/home/${USER_NAME}/.claude.json"

WORKDIR ${WORKSPACE_DIR}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
