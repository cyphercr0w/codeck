# Codeck - Production Image
# Uses pre-built base image with Claude CLI for faster rebuilds
#
# First time setup:
#   docker build -t codeck-base -f docker/Dockerfile.base .
#
# Then build normally:
#   docker build -t codeck -f docker/Dockerfile .

ARG BASE_IMAGE=codeck-base:latest
FROM ${BASE_IMAGE}

# Copy everything needed for build (source + configs)
COPY package.json package-lock.json tsconfig.json ./
COPY apps/runtime/package.json apps/runtime/tsconfig.json apps/runtime/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/
COPY apps/web/public apps/web/public

# Install ALL dependencies (including devDependencies for build)
RUN npm ci \
    && cp -r /prebuilt/node_modules/better-sqlite3 node_modules/better-sqlite3 2>/dev/null || true

# Copy source code
COPY apps/runtime/src apps/runtime/src
COPY apps/web/src apps/web/src

# Build inside container
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev \
    && cp -r /prebuilt/node_modules/better-sqlite3 node_modules/better-sqlite3 2>/dev/null || true

# Copy templates into runtime dist
COPY apps/runtime/src/templates ./apps/runtime/dist/templates

VOLUME ["/workspace", "/root/.claude"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost/api/runtime/health || exit 1

EXPOSE 80

ENV WORKSPACE=/workspace
ENV CODECK_DIR=/workspace/.codeck
ENV NODE_OPTIONS="--max-old-space-size=2048"
ENV CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
ENV CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50
ENV CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0
ENV ENABLE_TOOL_SEARCH=auto:5
ENV MAX_THINKING_TOKENS=10000

ENTRYPOINT ["/usr/local/bin/init-keyring.sh", "env", "NODE_ENV=production", "node", "apps/runtime/dist/index.js"]
CMD ["--web"]
