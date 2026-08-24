# Project environments are prebuilt images, not devcontainer features

**Fact.** Each project gets a template Dockerfile, `FROM claudops-base` plus
optional building blocks (dotnet SDK, Playwright with Chromium), built through the
Docker API on project create/change and tagged `claudops-project-<id>`. Instances
start from that image.

**Why.** devcontainer features were considered and rejected: they install at
container start, so every instance pays the full install time again and nothing is
layer-cached. Prebuilding turns that into a one-off cost per project, and an
unchanged rebuild finishes in seconds off the layer cache. The trade-off accepted
in exchange: a broken build has to be visible on the project and must block
instance start, because there is no fallback to on-the-fly installation.

**Applies to.** Issues #1, #7.
