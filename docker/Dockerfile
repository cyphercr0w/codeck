# Codeck - Production Image
# Uses pre-built base image with Claude CLI for faster rebuilds
#
# First time setup:
#   docker build -t codeck-base -f docker/Dockerfile.base .
#
# Then build normally:
#   docker compose -f docker/compose.yml build

ARG BASE_IMAGE=codeck-base:latest
FROM ${BASE_IMAGE}

# Copy package.json files for all workspaces so npm ci installs everything
COPY package.json package-lock.json ./
COPY apps/runtime/package.json apps/runtime/
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && cp -r /prebuilt/node_modules/better-sqlite3 node_modules/better-sqlite3 2>/dev/null || true

# Copy built outputs (runtime backend + daemon backend + web frontend)
COPY apps/runtime/dist ./apps/runtime/dist
COPY apps/daemon/dist ./apps/daemon/dist
COPY apps/web/dist ./apps/web/dist

# Copy templates into runtime dist (same layout as local build)
COPY apps/runtime/src/templates ./apps/runtime/dist/templates

VOLUME ["/workspace", "/root/.claude"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost/api/runtime/health || exit 1

EXPOSE 80

# NODE_ENV is NOT set globally — user dev servers need NODE_ENV=development.
# Our process sets it inline via the entrypoint.
ENV WORKSPACE=/workspace
# Limit V8 heap to ~50% of container memory limit (default: 2GB of 4GB).
# Override via CODECK_NODE_HEAP_MB env var in your .env file.
ENV NODE_OPTIONS="--max-old-space-size=2048"

ENTRYPOINT ["/usr/local/bin/init-keyring.sh", "env", "NODE_ENV=production", "node", "apps/runtime/dist/index.js"]
CMD ["--web"]
