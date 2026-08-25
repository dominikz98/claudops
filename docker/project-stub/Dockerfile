# Stand-in for docker/project/Dockerfile in the tests that drive the server.
#
# Same build args, no installs. What ./server/smoke-test.sh and ./e2e/run.sh
# have to prove is that the server turns a project's building blocks into a
# build, reports its outcome and gates instance creation on it -- none of which
# needs a real dotnet SDK, and all of which would otherwise wait minutes for
# one. Whether the toolchains really end up in the image is
# ./docker/project/smoke-test.sh, which is allowed to be slow.
#
# Point a server at it with CLAUDOPS_PROJECT_CONTEXT.
ARG BASE_IMAGE=claudops-base
FROM ${BASE_IMAGE}

ARG WITH_DOTNET=0
ARG WITH_PLAYWRIGHT=0
ARG DOTNET_CHANNEL=10.0

# The one artefact of this build: the args as the server passed them. `tee` puts
# them in two places on purpose -- in the image, readable from a container, and on
# stdout, so they end up in the build log the server stores. Both are what the
# tests assert on.
RUN printf 'dotnet=%s playwright=%s channel=%s\n' \
      "${WITH_DOTNET}" "${WITH_PLAYWRIGHT}" "${DOTNET_CHANNEL}" \
      | tee /tmp/claudops-blocks
