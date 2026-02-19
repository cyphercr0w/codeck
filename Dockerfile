# Codeck - Production Image
# Uses pre-built base image with Claude CLI for faster rebuilds
#
# First time setup:
#   docker build -t codeck-base -f Dockerfile.base .
#
# Then build normally:
#   docker compose build

FROM codeck-base:latest

# Copy package.json and install dependencies (rebuild native modules from source)
COPY package.json package-lock.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && cp -r /prebuilt/node_modules/better-sqlite3 node_modules/better-sqlite3 2>/dev/null || true

# Copy built outputs (runtime backend + web frontend)
COPY apps/runtime/dist ./apps/runtime/dist
COPY apps/web/dist ./apps/web/dist

# Copy templates into runtime dist (same layout as local build)
COPY apps/runtime/src/templates ./apps/runtime/dist/templates

VOLUME ["/workspace", "/root/.claude"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost/api/auth/status || exit 1

EXPOSE 80

# NODE_ENV is NOT set globally — user dev servers need NODE_ENV=development.
# Our process sets it inline via the entrypoint.
ENV WORKSPACE=/workspace
# Limit V8 heap to 50% of container memory (2GB of 4GB limit).
# Ensures headroom for PTY buffers, dev servers, tmpfs, and OS overhead.
# If you increase the container memory limit, increase this proportionally.
ENV NODE_OPTIONS="--max-old-space-size=2048"

ENTRYPOINT ["/usr/local/bin/init-keyring.sh", "env", "NODE_ENV=production", "node", "apps/runtime/dist/index.js"]
CMD ["--web"]
