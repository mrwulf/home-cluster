# Self-hosted Rowboat Spaces web app. Build context: a checkout of
# rowboatlabs/rowboat at the pinned release; the `cfg` named context is this
# directory (see .github/workflows/rowboat-harbor-image.yaml).
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /rowboat
COPY apps ./apps
COPY --from=cfg patch.mjs /tmp/patch.mjs
RUN node /tmp/patch.mjs apps/x/apps/renderer
WORKDIR /rowboat/apps/x/apps/renderer
# Upstream's own Vercel install and build scripts (the web app's documented build).
RUN sh scripts/vercel-install.sh && sh scripts/vercel-build.sh

FROM nginxinc/nginx-unprivileged:1.31.7-alpine
COPY --from=build /rowboat/apps/x/apps/renderer/dist-web /usr/share/nginx/html
COPY --from=cfg default.conf.template /etc/nginx/templates/default.conf.template
