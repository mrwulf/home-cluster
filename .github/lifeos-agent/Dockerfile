# LifeOS on Claude Code, answering mentions in Rowboat Spaces. Build context:
# apps/harbor of the Rowboat fork at the pinned worker commit. Named
# contexts: `cfg` is this directory, `lifeos` a checkout of
# danielmiessler/LifeOS (see .github/workflows/lifeos-agent-image.yaml).
FROM node:24.22.3-bookworm-slim AS worker
RUN corepack enable
WORKDIR /harbor
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm -r build \
  && pnpm --filter @rowboat/worker typecheck \
  && pnpm --filter @rowboat/worker test

FROM oven/bun:1.4.5-slim AS bun

FROM node:24.22.3-bookworm-slim
ARG CLAUDE_CODE_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps python3 ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:?}"
COPY --from=lifeos LifeOS /opt/lifeos/LifeOS
# The Pulse desktop app needs a compiler to install and a display to run.
RUN rm -rf /opt/lifeos/LifeOS/install/LIFEOS/PULSE/Desktop
COPY --from=worker /harbor/packages/worker/dist/rowboat-worker.cjs /opt/rowboat-worker.cjs
COPY --from=cfg image/git-setup.sh /usr/local/lib/lifeos-agent/git-setup.sh
COPY --from=cfg --chmod=755 image/lifeos-bootstrap.sh /usr/local/bin/lifeos-bootstrap
COPY --from=cfg --chmod=755 image/init.sh /usr/local/bin/lifeos-init
COPY --from=cfg --chmod=755 image/agent.sh /usr/local/bin/lifeos-agent
COPY --from=cfg --chmod=755 image/vault-sync.sh /usr/local/bin/lifeos-vault-sync
ENV DISABLE_AUTOUPDATER=1
USER 1000:1000
CMD ["lifeos-agent"]
