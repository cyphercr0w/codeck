# Configuration — Codeck Sandbox

---

## Environment Variables

All environment variables are for the single container runtime. Set via `.env` file, `docker compose` environment, or `docker run -e`.

| Variable | Default | Description |
|----------|---------|-------------|
| `CODECK_PORT` | `80` | HTTP listening port inside the container |
| `WORKSPACE` | `/workspace` | Workspace directory for projects |
| `CODECK_DIR` | `/workspace/.codeck` | Codeck data directory (auth, config, memory, rules, skills, preferences, agents) |
| `CODECK_NETWORK_MODE` | `bridge` | Docker network mode (bridge only) |
| `CODECK_MAPPED_PORTS` | — | Comma-separated port ranges exposed from Docker (e.g., `80,3000-3009,5173-5179`) |
| `CODECK_MEMORY_LIMIT` | `0` | Docker memory limit for the container (e.g., `4G`). Set to `0` for unlimited. |
| `CODECK_NODE_HEAP_MB` | `2048` | Node.js `--max-old-space-size` in MB |
| `CODECK_ENCRYPTION_KEY` | (hostname-based) | Encryption key for OAuth token storage. **Recommended:** Set to a random 32+ char string for production. |
| `GITHUB_TOKEN` | — | **Optional.** Token for cloning private repos via HTTPS. Use fine-grained PATs. |
| `ANTHROPIC_API_KEY` | — | **Optional.** Alternative to OAuth login. Prefer OAuth. |
| `GEMINI_API_KEY` | — | **Optional.** Gemini API key for embedding fallback (free tier). Enables semantic/hybrid search. |
| `NODE_ENV` | `production` | Set in Dockerfile |
| `SESSION_TTL_MS` | `604800000` | Session token lifetime in milliseconds (default: 7 days) |
| `SESSION_RESTORE_DELAY` | `2000` | Delay in ms before restoring PTY sessions on startup |
| `AGENT_SIGKILL_GRACE_MS` | `15000` | Grace period (ms) between SIGTERM and SIGKILL for proactive agent timeouts. Clamped to 5000-60000. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Auto-set per PTY session from .credentials.json |

### Configuration Validation

Codeck does not currently enforce schema validation for environment variables at startup. Invalid or malformed values silently fall back to defaults (e.g., `CODECK_PORT=abc` → `80`). For production deployments, verify:

1. **Numeric Variables**: Ensure `CODECK_PORT`, `SESSION_TTL_MS`, and `SESSION_RESTORE_DELAY` are valid integers.
2. **Network Mode**: `CODECK_NETWORK_MODE` is always `bridge`.
3. **Encryption Key**: Set `CODECK_ENCRYPTION_KEY` to a random 32+ character string for production.

---

## Security: Encryption

### CODECK_ENCRYPTION_KEY

Claude OAuth tokens are encrypted at rest using AES-256-GCM. The encryption key is derived from:

1. **`CODECK_ENCRYPTION_KEY` environment variable** (if set) — recommended for production
2. **Machine hostname** (fallback) — derived via scrypt from `process.env.HOSTNAME`

**For production deployments:**

```bash
# Generate a random 32-byte key (base64-encoded):
export CODECK_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Or set it in .env:
echo "CODECK_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
```

**Key properties:**
- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key derivation:** scrypt with fixed salt
- **IV:** Unique 16-byte random IV per encryption operation
- **Format:** v2 encrypted credentials in `/root/.claude/.credentials.json`

### File Permissions

Credential storage uses restrictive permissions:

**Directories:** 0700 (owner read/write/execute only)
- `/workspace/.codeck/` — Codeck config, auth, and memory
- `/root/.claude/` — Claude CLI credentials and config
- `/root/.ssh/` — SSH keys

**Files:** 0600 (owner read/write only)
- `/workspace/.codeck/auth.json` — Scrypt password hash and salt
- `/workspace/.codeck/sessions.json` — Session tokens
- `/workspace/.codeck/accounts.json` — Multi-account registry (metadata only, no tokens)
- `/workspace/.codeck/accounts/<uuid>/` — Isolated `CLAUDE_CONFIG_DIR` per additional account (credentials, projects, settings)
- `/root/.claude/.credentials.json` — Encrypted OAuth tokens (default account)
- `/root/.claude/.pkce-state.json` — PKCE flow state (ephemeral)
- `/root/.ssh/id_ed25519` — SSH private key

Permission validation and repair is performed on credential file reads.

### Secret Rotation

**Password Sessions:**
- Change password via web UI → all sessions invalidated
- 7-day fixed TTL (configurable via `SESSION_TTL_MS`)
- No sliding window

**OAuth Tokens:**
- Auto-refresh before expiry (365-day lifetime, 30-minute refresh margin)
- Encrypted at rest with AES-256-GCM

**Encryption Key:**
- Static (no automated rotation)
- To rotate: set new key, trigger OAuth re-authentication

### Encrypted Environment Variables

Codeck supports encrypted environment variables for storing service credentials securely:

- Credentials are encrypted with AES-256-GCM and stored in `/workspace/.codeck/.env.encrypted`
- The encryption key is derived from `CODECK_ENCRYPTION_KEY`
- The agent can store and retrieve credentials via the Codeck API without exposing plaintext values
- Encrypted vars are decrypted at runtime and injected into the environment as needed

---

## Logging Configuration

### Docker Log Rotation

The compose file configures Docker's `json-file` driver with rotation:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"    # Rotate after 10MB
    max-file: "3"      # Keep 3 rotated files (30MB max total)
    compress: "true"   # Compress rotated logs
```

Manual log inspection: `docker logs codeck`

### Console Log Interception

`logger.ts` intercepts `console.log`, `console.error`, `console.warn`, and `console.info` globally. All output passes through `sanitizeSecrets()` before buffering and WebSocket broadcast.

### Log Retention

| Log Type | Location | Retention |
|----------|----------|-----------|
| Session transcripts | `/workspace/.codeck/sessions/*.jsonl` | No automatic expiry |
| Agent execution logs | `/workspace/.codeck/agents/*/executions/` | Auto-pruned: last 100 per agent |
| Memory daily logs | `/workspace/.codeck/memory/daily/*.md` | No automatic expiry |
| Docker container logs | Docker json-file driver | Rotated: 10MB max, 3 files |

### Secret Sanitization

All logs pass through `sanitizeSecrets()` before writing. 15+ regex patterns cover AWS, GitHub, Anthropic, and other provider tokens. See `session-writer.ts` for the full pattern list.

---

## Docker Build

### Prerequisites

Build the base image first (one-time):

```bash
docker build -t codeck-base -f docker/Dockerfile.base .
```

### Build and run

```bash
npm run build                                       # Build frontend + backend
docker compose -f docker/compose.yml up --build     # Build + start
```

### Image layers

```
codeck-base (~1.5GB)
├── node:22-slim (SHA256 digest-pinned)
├── System: build-essential, python3, git, openssh, dbus, gnome-keyring, libsecret
├── @anthropic-ai/claude-code@<pinned-version>
├── node-pty pre-compiled in /prebuilt/
└── init-keyring.sh

codeck (production, ~200MB on top of base)
├── npm install --omit=dev
├── Pre-built node-pty copied from /prebuilt/
├── dist/ (pre-built on host)
└── apps/runtime/src/templates/
```

### Base Image Security

The base image (`node:22-slim`) is pinned to a specific SHA256 digest in `docker/Dockerfile.base` for reproducible builds and supply chain protection:

```dockerfile
FROM node:22-slim@sha256:<digest>
```

**Update schedule:**
- **Monthly**: Check for new digest and Debian security updates
- **Immediate**: Update within 24 hours for CRITICAL CVE with active exploitation
- **Weekly**: Review Debian security advisories

**Claude CLI version** is pinned to an explicit version in `docker/Dockerfile.base`. Auto-update at runtime via `POST /api/system/update-agent` is also available.

---

## Docker Compose Configuration

### Single compose file

The project uses a single `docker/compose.yml` file. No separate isolated or managed modes.

### Volumes

| Volume | Container path | Purpose |
|--------|---------------|---------|
| `codeck-workspace` | `/workspace` | Projects and repos |
| `codeck-claude` | `/root/.claude` | OAuth credentials, settings, MCP config |
| `codeck-ssh` | `/root/.ssh` | SSH keys |
| `codeck-gh` | `/root/.config/gh` | GitHub CLI OAuth token |

### Security hardening

```yaml
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
cap_add:
  - CHOWN         # File ownership
  - SETUID        # Process identity
  - SETGID        # Process identity
  - NET_BIND_SERVICE  # Bind to low ports
  - KILL          # Signal processes
  - DAC_OVERRIDE  # File permission override (gnome-keyring, dbus, ssh)
pids_limit: 512   # Fork bomb protection
```

**Note on `DAC_OVERRIDE`:** Required by gnome-keyring and dbus initialization. If you don't need the keyring (e.g., using API key auth only), you may try removing it.

### Tmpfs mounts

```yaml
tmpfs:
  - /tmp:size=512M,mode=1777
  - /run:size=100M,mode=0755
```

Ephemeral, cleared on restart. Increase `/tmp` if large npm installs fail with "No space left on device."

### Resource limits

```yaml
deploy:
  resources:
    limits:
      memory: ${CODECK_MEMORY_LIMIT:-0}
      pids: 512
    reservations:
      memory: 256M
```

### Health check

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:80/api/auth/status"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

### Docker socket

Not mounted by default. Port exposure uses compose override files + helper containers. This is a deliberate security decision — the container is fully isolated from the Docker daemon.

### Volume data protection

Running `docker compose down -v` permanently deletes all data including projects, OAuth credentials, SSH keys, and agent memory.

**For production**, mark critical volumes as `external: true`:

```bash
docker volume create codeck-workspace
docker volume create codeck-claude
docker volume create codeck-ssh
docker volume create codeck-gh
```

```yaml
volumes:
  codeck-workspace:
    external: true
```

---

## Preset System

### Overview

Presets define template-based workspace configurations. The default preset (v8.2.0) installs:
- Memory system directories and MEMORY.md
- Rules (common + language-specific)
- Skills (118 skill files)
- Sub-agents (28 agent definitions in `/root/.claude/agents/`)
- Hooks (workflow enforcement: edit-tracker, checkpoint, context-injector)
- MCP server configuration (`mcp.json` with 9 servers)
- CLAUDE.md instruction files (global + workspace layers)

### Creating custom presets

1. Create directory: `apps/runtime/src/templates/presets/<preset-id>/`
2. Create `manifest.json`:

```json
{
  "id": "my-preset",
  "name": "My Custom Preset",
  "description": "Description shown in the wizard",
  "version": "1.0.0",
  "author": "your-name",
  "icon": "...",
  "tags": ["custom"],
  "extends": "default",
  "files": [
    { "src": "skills/my-skill.md", "dest": "/workspace/.codeck/skills/my-skill.md" }
  ],
  "directories": []
}
```

3. Add template files referenced in `files[].src`
4. Rebuild the Docker image

### Inheritance

Use `"extends": "default"` to inherit all files from the default preset. Your preset's files overwrite matching destinations. Max chain depth: 5.

### Data file protection

Files in `memory/` paths, named `preferences.md`, or in `rules/` paths are "data files". Only copied on first apply; subsequent applies skip them to preserve user customizations. Use `POST /api/presets/reset` (force) to overwrite.

### On-demand language rules loading

Language-specific rules (rust, java, kotlin, csharp, php, perl, swift, cpp, python, golang) live in `/workspace/.codeck/rules-library/` rather than `~/.claude/rules/`. Only `common/` and `typescript/` are permanently installed in `~/.claude/rules/`. When a Claude session starts, `setupLanguageRules(cwd)` in `console.ts` detects the project language from indicator files (e.g., `Cargo.toml` → rust, `requirements.txt` → python) and symlinks the matching ruleset into `~/.claude/rules/` before spawning Claude Code. Projects using undetected languages load only the common rules. This saves ~84KB (~21,000 tokens) of context per session for projects that don't use those languages.

---

## MCP Server Configuration

MCP (Model Context Protocol) servers are configured in `/root/.claude/mcp.json` and registered in `/root/.claude.json` at startup.

The default preset installs 9 MCP servers that provide additional tools to Claude Code (Playwright browser automation, ESLint linting, etc.).

### Configuration file

`/root/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@package/name"],
      "env": {}
    }
  }
}
```

### MCP permissions

MCP server tools can be allowed or denied via the permissions API:
- `GET /api/permissions/mcp` — list server permission states
- `POST /api/permissions/mcp` — set `{ name, allowed }` for a server

Permissions are synced to `~/.claude/settings.json`.

---

## CLI Permissions

Permissions control which Claude CLI tools are pre-allowed without user confirmation.

### Workspace trust dialog

Claude Code shows a trust prompt on first use in a directory. Codeck suppresses this by writing `hasTrustDialogAccepted: true` and `hasCompletedOnboarding: true` to `/root/.claude.json` before each session spawn.

### Storage

Stored in `/workspace/.codeck/config.json` under the `permissions` field:

```json
{
  "presetId": "default",
  "presetName": "Default",
  "permissions": {
    "Read": true,
    "Edit": true,
    "Write": true,
    "Bash": true,
    "WebFetch": true,
    "WebSearch": true
  }
}
```

### Behavior

- Enabled permissions synced to `/root/.claude/settings.json` `permissions.allow` array before each session spawn
- Changes apply to **new sessions only**
- MCP server permissions are also synced

---

## Keyring Configuration

Claude CLI requires a system keyring for token storage. In Docker (headless), this is simulated:

```bash
# init-keyring.sh (runs as ENTRYPOINT)
dbus-daemon --system --fork
eval $(dbus-launch --sh-syntax)
echo "" | gnome-keyring-daemon --unlock
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK
exec "$@"
```

Codeck also writes tokens directly to `.credentials.json` as a more reliable fallback for container environments.

---

## Network Access

### Local (same machine)

- **Dashboard:** `http://localhost:8080` (or mapped port)
- **Dev server preview:** `http://localhost:{port}`
- Only the Codeck port (default 80, mapped to 8080) is exposed by default. Additional ports added via dashboard, API, or `compose.override.yml`.

### LAN (codeck.local)

LAN access via mDNS makes `codeck.local` resolvable from phones, tablets, and other devices.

- **Dashboard:** `http://codeck.local`
- **Dev server preview:** `http://codeck.local:{port}`
- **Direct IP access:** `http://{HOST_IP}:{port}`

### Security

- mDNS has no authentication — only use on trusted networks
- Do NOT use LAN mode on public WiFi or shared networks

### Port exposure

Only the Codeck port is mapped by default. Dev server ports are exposed by adding them via:
- **Dashboard UI**: Port Mapping card
- **API**: `POST /api/system/add-port` with `{"port": N}`
- **Manual**: Edit `compose.override.yml` and restart

When a port is added via the UI or API, the system:
1. Writes `compose.override.yml` on the host (via Docker helper container)
2. Saves active sessions to disk
3. Restarts the container with new port mapping
4. Sessions auto-restore on the new container

### Custom port ranges

Create or edit `docker/compose.override.yml`:

```yaml
services:
  codeck:
    ports:
      - "127.0.0.1:8080:80"
      - "3000:3000"
      - "5173:5173"
    environment:
      - CODECK_MAPPED_PORTS=80,3000,5173
```

---

## Local Development (without Docker)

```bash
# Install dependencies
npm install

# Start backend with hot-reload
npm run dev

# In another terminal, start frontend dev server
cd apps/web && npx vite

# Frontend runs on :5173, proxies API to backend
```

Note: `node-pty` requires C++ build tools. On macOS: `xcode-select --install`. On Linux: `build-essential`.

---

## Supply Chain Security

### Dependency Management

- **Base image pinning:** `node:22-slim` pinned to SHA256 digest
- **npm package pinning:** All deps locked via `package-lock.json` (lockfile version 3)
- **Claude CLI pinning:** Exact version in Dockerfile.base

### Trusted Publishers

- **Native deps:** node-pty (Microsoft), better-sqlite3 (WiseLibs)
- **Core runtime:** express (OpenJS Foundation), ws (websockets org)
- **Frontend:** preact (preactjs), vite (vitejs)

### Binary Artifacts

- better-sqlite3: Prebuilt binaries from GitHub releases, SHA512 verified
- node-pty: Compiled from source (no binary downloads)

### Install Script Safety

Native addons execute install scripts during `npm install`. To audit:

```bash
npm install --ignore-scripts  # Skip install scripts
npm rebuild                   # Manually rebuild after inspection
```

---

## Resource Tuning for Agent Teams

When Claude Code launches Agent Teams (leader + sub-agents), CPU usage spikes because multiple processes run concurrently inside the container.

### Recommended Resources

| Scenario | CPUs | Memory |
|----------|------|--------|
| Solo agent (default) | 1-2 | 2G |
| Agent Teams (2-3 teammates) | 4 | 4G |
| Agent Teams (4-5 teammates) | 6+ | 6G+ |

### CPU Limits

Set `CODECK_CPUS` to cap how many host CPUs the container may use:

```bash
# Via installer:
CODECK_CPUS=4 curl -fsSL https://codeck.xyz/install | bash

# Via docker run:
docker run --cpus=4 ...

# Via compose (.env file):
CODECK_CPUS=4
```

### Process Priority (nice)

All `claude` processes run at `nice` level 10 by default. This ensures the web UI stays responsive even under heavy agent load. Teammates inherit the leader's nice level automatically.

### Max Teammates

When launching a session with Agent Teams, you can configure **Max Teammates** (1-10, default 3) in the New Session dialog. This limits how many sub-agents the leader can spawn simultaneously, preventing CPU exhaustion on resource-constrained machines.

The limit is set via `CLAUDE_MAX_TEAMMATES` environment variable inside the container.
