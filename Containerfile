# syntax=docker/dockerfile:1
# Self-hosted explainer service: web UI + API + job queue + renderer (Astro) + render checks (Chromium).
FROM node:26-bookworm-slim

ENV NODE_ENV=production \
    EXPLAINER_DATA_DIR=/data \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ASTRO_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN mkdir -p /app /data /ms-playwright && chown node:node /app /data
WORKDIR /app

# Headless Chromium + its system libraries (needs root; same Playwright version as the lockfile).
COPY --chown=node:node package.json package-lock.json ./
RUN PW_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/playwright'].version")" \
 && npx -y "playwright@${PW_VERSION}" install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

USER node
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node . .
# Build the web UI, then prove the renderer works inside the image (build + render-check the showcase).
RUN npm run build:app \
 && npm test \
 && rm -rf .build fixtures/showcase/.check fixtures/showcase/index.html

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.ts"]
