# claudops project image -- the environment one project's instances run in.
#
# One template for every project, steered by build args, rather than a Dockerfile
# generated per project: identical building blocks produce identical
# instructions, so two projects with the same environment share their layers and
# an unchanged rebuild comes straight off the cache.
#
#   docker build -t claudops-project-demo \
#     --build-arg WITH_DOTNET=1 --build-arg WITH_PLAYWRIGHT=1 docker/project
#
# The server builds this through the Docker API on project create and whenever
# the building blocks change -- see server/src/projects/images.ts.
ARG BASE_IMAGE=claudops-base
FROM ${BASE_IMAGE}

ARG WITH_DOTNET=0
ARG WITH_PLAYWRIGHT=0
# Channel for dotnet-install.sh: a version ("10.0"), "LTS" or "STA".
ARG DOTNET_CHANNEL=10.0
# Matches USER_NAME in docker/base/Dockerfile. The base image's own ARG is not
# in scope here, so it is named again.
ARG USER_NAME=claude

# The blocks install system-wide, so they need root; the last line hands the
# image back to the unprivileged user it inherited.
USER root

# Unconditional on purpose -- a Dockerfile cannot set ENV behind an `if`, and
# these are harmless when the block they belong to was not built.
#
# PLAYWRIGHT_BROWSERS_PATH is the one that matters: the browsers are installed
# by root, and without a shared path they would land in /root/.cache where the
# `claude` user cannot read them (knowledge/playwright-browsers-need-a-shared-path.md).
#
# NODE_PATH makes the globally installed playwright requirable from a repository
# that does not depend on it itself. A local node_modules still wins.
ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:${PATH} \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules

# One RUN per block, each referencing its own ARG: that is what makes the value
# part of the layer's cache key, so flipping one block does not invalidate the
# other. There is deliberately no COPY in this file -- the build context stays
# out of every cache key, which is also why a block that needs its hosts on the
# egress whitelist writes its own drop-in into
# /etc/claudops/firewall-allow.d rather than copying a file in.
#
# Note that the build itself is not firewalled: the entrypoint installs the
# firewall at container start, so dotnet-install.sh and `playwright install`
# reach whatever they need here.
RUN if [ "${WITH_DOTNET}" = "1" ]; then \
      set -eux; \
      apt-get update; \
      apt-get install -y --no-install-recommends libicu72; \
      rm -rf /var/lib/apt/lists/*; \
      curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh; \
      bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir "${DOTNET_ROOT}"; \
      rm /tmp/dotnet-install.sh; \
      ln -sf "${DOTNET_ROOT}/dotnet" /usr/local/bin/dotnet; \
      dotnet --version; \
      printf '%s\n' \
        '# nuget and the dotnet CLI, added by the dotnet building block.' \
        'api.nuget.org' \
        'globalcdn.nuget.org' \
        'www.nuget.org' \
        'builds.dotnet.microsoft.com' \
        'ci.dot.net' \
        > /etc/claudops/firewall-allow.d/10-dotnet.conf; \
      chmod 0644 /etc/claudops/firewall-allow.d/10-dotnet.conf; \
    fi

RUN if [ "${WITH_PLAYWRIGHT}" = "1" ]; then \
      set -eux; \
      npm install -g playwright; \
      npm cache clean --force; \
      playwright install --with-deps chromium; \
      chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"; \
    fi

USER ${USER_NAME}
