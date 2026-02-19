# Configuration & Deployment — Codeck Sandbox

---

## Environment Variables

### Runtime

| Variable | Default | Description |
|----------|---------|-------------|
| `CODECK_PORT` | `80` | Runtime HTTP listening port. In gateway mode, set to `7777` (internal). |
| `CODECK_WS_PORT` | — | **Optional.** Separate WebSocket port. If set and differs from `CODECK_PORT`, creates a dedicated WS server. Required for gateway mode (e.g., `7778`). |
| `WORKSPACE` | `/workspace` | Workspace directory for projects |
| `CODECK_DIR` | `/workspace/.codeck` | Codeck data directory (auth, config, memory, rules, skills, preferences) |
| `GITHUB_TOKEN` | — | **Optional.** Token for cloning private repos via HTTPS. Use fine-grained PATs. |
| `ANTHROPIC_API_KEY` | — | **Optional.** Alternative to OAuth login. Prefer OAuth. |
| `NODE_ENV` | `production` | Set in Dockerfile |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Auto-set per PTY session from .credentials.json |
| `CODECK_NETWORK_MODE` | `bridge` | Docker network mode (bridge only, kept for compatibility) |
| `CODECK_MAPPED_PORTS` | — | Comma-separated port ranges exposed from Docker (e.g., `80,3000-3009,5173-5179`) |
| `SESSION_TTL_MS` | `604800000` | Session token lifetime in milliseconds (default: 7 days) |
| `SESSION_RESTORE_DELAY` | `2000` | Delay in ms before restoring PTY sessions on startup |
| `CODECK_ENCRYPTION_KEY` | (hostname-based) | Encryption key for Claude OAuth token storage. **Recommended:** Set to a random 32+ character string for production. |
| `AGENT_SIGKILL_GRACE_MS` | `15000` | Grace period (ms) between SIGTERM and SIGKILL for proactive agent timeouts. Clamped to 5000–60000. |
| `GEMINI_API_KEY` | — | **Optional.** Gemini API key for embedding fallback (free tier). Enables semantic/hybrid search. |

### Daemon (gateway mode only)

| Variable | Default | Description |
|----------|---------|-------------|
| `CODECK_DAEMON_PORT` | `8080` | Daemon listening port (exposed to host) |
| `CODECK_RUNTIME_URL` | `http://codeck-runtime:7777` | Runtime HTTP URL for proxy |
| `CODECK_RUNTIME_WS_URL` | `CODECK_RUNTIME_URL` | Runtime WebSocket URL. Set separately when WS runs on a different port (e.g., `http://codeck-runtime:7778`). |
| `CODECK_DIR` | `/workspace/.codeck` | Same as runtime — daemon reads `auth.json`, writes `daemon-sessions.json` and `audit.log` |
| `SESSION_TTL_MS` | `604800000` | Daemon session lifetime (default: 7 days) |
| `PROXY_TIMEOUT_MS` | `30000` | HTTP proxy timeout (ms) |
| `MAX_WS_CONNECTIONS` | `20` | Max concurrent WebSocket connections |
| `WS_PING_INTERVAL_MS` | `30000` | WebSocket keepalive ping interval (ms) |
| `RATE_AUTH_MAX` | `10` | Auth endpoint rate limit (requests per window) |
| `RATE_AUTH_WINDOW_MS` | `60000` | Auth rate limit window (ms) |
| `RATE_WRITES_MAX` | `60` | Write endpoint rate limit (requests per window) |
| `RATE_WRITES_WINDOW_MS` | `60000` | Write rate limit window (ms) |
| `LOCKOUT_THRESHOLD` | `5` | Failed login attempts before lockout |
| `LOCKOUT_DURATION_MS` | `900000` | Lockout duration (ms, default 15 min) |

### Configuration Validation

Codeck does not currently enforce schema validation for environment variables at startup. Invalid or malformed values silently fall back to defaults (e.g., `CODECK_PORT=abc` → `80`). For production deployments, verify the following:

1. **Numeric Variables**: Ensure `CODECK_PORT`, `SESSION_TTL_MS`, and `SESSION_RESTORE_DELAY` are valid integers.
2. **Network Mode**: `CODECK_NETWORK_MODE` is always `bridge` (host mode has been removed).
3. **Encryption Key**: Set `CODECK_ENCRYPTION_KEY` to a random 32+ character string for production (see "Security: CODECK_ENCRYPTION_KEY" below).

**Future Enhancement**: Planned migration to Zod-based schema validation with startup-time checks and fail-fast behavior. See `AUDIT-107` for details.

### Security: CODECK_ENCRYPTION_KEY

Claude OAuth tokens are encrypted at rest using AES-256-GCM. The encryption key is derived from:

1. **`CODECK_ENCRYPTION_KEY` environment variable** (if set) — recommended for production
2. **Machine hostname** (fallback) — derived via scrypt from `process.env.HOSTNAME`

**For production deployments**, set an explicit encryption key to ensure tokens remain secure even if the container is moved to a different host:

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

### Security: File Permissions

Credential storage directories and files use restrictive permissions to prevent unauthorized access:

**Directories:** 0700 (owner read/write/execute only)
- `/workspace/.codeck/` — Codeck config, auth, and memory
- `/root/.claude/` — Claude CLI credentials and config
- `/root/.ssh/` — SSH keys

**Files:** 0600 (owner read/write only)
- `/workspace/.codeck/auth.json` — Scrypt password hash and salt
- `/workspace/.codeck/sessions.json` — Session tokens
- `/root/.claude/.credentials.json` — Encrypted OAuth tokens (AES-256-GCM)
- `/root/.claude/.pkce-state.json` — PKCE flow state (ephemeral)
- `/root/.ssh/id_ed25519` — SSH private key

**Enforcement:**
- Directory permissions are set to 0700 on creation (`mkdirSync` with `mode` parameter)
- File permissions are enforced via `{ mode: 0o600 }` on write
- Credential file permissions are validated and repaired on read (see `auth-anthropic.ts:validateCredentialsPermissions()`)

These permissions align with industry standards (OWASP, NIST, SSH best practices) and implement defense-in-depth: encryption + file permissions + directory permissions.

**Warning:** Manual `chmod` on these directories or files may weaken security. Permission validation will attempt to repair insecure permissions on next read.

### Security: Secret Rotation

Codeck does not implement automated secret rotation. Manual rotation procedures:

**Password Sessions:**
- Change password via web UI → all existing session tokens are invalidated immediately (except a new token issued for the current session)
- Session tokens have a fixed 7-day TTL (configurable via `SESSION_TTL_MS`)
- No sliding window — tokens are not refreshed on activity

**OAuth Tokens:**
- Claude OAuth tokens automatically refresh before expiry (365-day lifetime, 5-minute refresh margin)
- If refresh fails, manual re-authentication required via web UI
- Tokens encrypted at rest with AES-256-GCM (see CODECK_ENCRYPTION_KEY above)

**GitHub Token:**
- No automatic rotation — stored in .env (plaintext on host)
- Recommendation: Regenerate GitHub token periodically (monthly for production, as-needed for personal use)
- Use [fine-grained personal access tokens](https://github.com/settings/tokens?type=beta) with repository-scoped permissions and expiration dates

**Encryption Key:**
- CODECK_ENCRYPTION_KEY is static (no rotation mechanism)
- To rotate: (1) set new CODECK_ENCRYPTION_KEY, (2) trigger OAuth re-authentication to re-encrypt tokens
- Future enhancement: Implement key rotation with re-encryption of existing credentials

For team deployments requiring automated rotation, consider integrating external secret managers (AWS Secrets Manager, HashiCorp Vault) or Docker Secrets with rotation policies.

---

## Logging Configuration

### Docker Log Rotation

All compose files configure Docker's `json-file` driver with rotation to prevent unbounded disk growth:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"    # Rotate after 10MB
    max-file: "3"      # Keep 3 rotated files (30MB max total)
    compress: "true"   # Compress rotated logs
```

Manual log inspection: `docker logs codeck-sandbox-1`

### Console Log Interception

`logger.ts` intercepts `console.log`, `console.error`, `console.warn`, and `console.info` globally. All intercepted output passes through `sanitizeSecrets()` before buffering and WebSocket broadcast.

### Log Retention

| Log Type | Location | Retention |
|----------|----------|-----------|
| Session transcripts | `/workspace/.codeck/memory/sessions/*.jsonl` | No automatic expiry (manual deletion via File Browser) |
| Agent execution logs | `/workspace/.codeck/agents/*/executions/` | Auto-pruned: keeps last 100 executions per agent |
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

### Production

Requires pre-built `dist/` directory:

```bash
npm run build                    # Build frontend + backend
docker compose -f docker/compose.yml up --build   # Uses docker/Dockerfile (production)
```

### Development

Builds from source inside the container:

```bash
docker compose -f docker/compose.yml -f docker/compose.dev.yml up --build
```

### Image layers

```
codeck-base (~1.5GB)
├── node:22-slim
├── System: build-essential, python3, git, openssh, dbus, gnome-keyring, libsecret
├── @anthropic-ai/claude-code@latest (~200MB)
├── node-pty pre-compiled in /prebuilt/
└── init-keyring.sh

codeck (production, ~200MB on top of base)
├── npm install --omit=dev
├── Pre-built node-pty copied from /prebuilt/
├── dist/ (pre-built on host)
└── apps/runtime/src/templates/

codeck-dev (development, ~300MB on top of base)
├── npm install (all deps including Vite, TypeScript)
├── npm run build (inside container)
└── Same runtime config as production
```

### Base Image Security

#### Digest Pinning

The base image (`node:22-slim`) is pinned to a specific SHA256 digest in `docker/Dockerfile.base` to ensure reproducible builds and prevent supply chain attacks:

```dockerfile
FROM node:22-slim@sha256:5373f1906319b3a1f291da5d102f4ce5c77ccbe29eb637f072b6c7b70443fc36
```

**To update the base image:**

1. Check for new Node.js 22.x releases: https://hub.docker.com/_/node/tags?name=22-slim
2. Pull the latest digest:
   ```bash
   docker pull node:22-slim
   docker inspect node:22-slim | grep -A 1 RepoDigests
   ```
3. Scan new digest for vulnerabilities (optional but recommended):
   ```bash
   docker run --rm aquasec/trivy:latest image --severity CRITICAL,HIGH node:22-slim@sha256:<new-digest>
   ```
4. Update the digest in `docker/Dockerfile.base` line 7
5. Rebuild: `docker build -t codeck-base -f docker/Dockerfile.base .`
6. Test in dev mode before deploying to production

**Update Schedule:**
- **Monthly**: Check for new digest and Debian security updates (2nd Tuesday aligns with Node.js security releases)
- **Immediate**: Update within 24 hours if CRITICAL CVE with active exploitation
- **Weekly**: Review [Debian security advisories](https://www.debian.org/security/) for Bookworm

**CVE Severity Thresholds:**
- **CRITICAL with exploit**: Immediate update required
- **CRITICAL without exploit**: Update within 7 days
- **HIGH**: Update within 30 days or next monthly cycle
- **MEDIUM/LOW**: Update at next scheduled monthly refresh
- **No fix available**: Document risk acceptance in [KNOWN-ISSUES.md](KNOWN-ISSUES.md)

**Known CVEs (as of 2026-02-14):**
- CVE-2026-0861, CVE-2026-0915, CVE-2025-15281: glibc vulnerabilities with no Debian fix available. Risk assessed as LOW for Codeck threat model (see [AUDIT-110](auditory/AUDIT-110-docker-base-image-cve-scan.md) for details).

#### Claude CLI Version

The Claude CLI is pinned to an explicit version in `docker/Dockerfile.base`:

```dockerfile
RUN npm install -g pnpm @anthropic-ai/claude-code@2.1.39
```

**To update the Claude CLI version:**

1. Check for new releases: https://www.npmjs.com/package/@anthropic-ai/claude-code
2. Review the changelog: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
3. Update the version in `docker/Dockerfile.base` line 54
4. Rebuild the base image and test

The server can also auto-update the Claude CLI at runtime via `POST /api/system/update-agent`, but base image pinning ensures a known-good version is always available on container restart.

---

## Docker Compose Configuration

### Volumes

| Volume | Container path | Purpose |
|--------|---------------|---------|
| `workspace` | `/workspace` | Projects and repos |
| `claude-config` | `/root/.claude` | OAuth credentials, CLAUDE.md, MCP config |
| `codeck-data` | `/workspace/.codeck` | Codeck data (auth, config, memory, rules, skills) |
| `ssh-data` | `/root/.ssh` | SSH keys |
| `gh-config` | `/root/.config/gh` | GitHub CLI OAuth token (persists `gh auth login` across restarts) |

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

**Note on `DAC_OVERRIDE`:** This capability allows bypassing file permission checks. It is required by gnome-keyring and dbus initialization inside the container. If you don't need the keyring (e.g., using API key auth only), you may try removing it — test that `init-keyring.sh` still works without it.

### Read-Only Filesystem

```yaml
read_only: true
tmpfs:
  - /tmp:size=512M,mode=1777
  - /run:size=100M,mode=0755
  - /run/dbus:size=10M,mode=0755
  - /var/run:size=10M,mode=0755
```

The container runs with a read-only root filesystem to prevent malicious code from persisting filesystem modifications, installing backdoors, or modifying application binaries. Writable directories are limited to:

- **tmpfs mounts** (ephemeral, cleared on restart): `/tmp`, `/run`, `/run/dbus`, `/var/run`
- **Persistent volumes**: `/workspace`, `/workspace/.codeck`, `/root/.claude`, `/root/.ssh`

Each tmpfs mount has explicit size limits and permissions:

| Mount | Size | Mode | Purpose |
|-------|------|------|---------|
| `/tmp` | 512M | 1777 | Temporary files (npm cache, build artifacts, dev server temp files) |
| `/run` | 100M | 0755 | Runtime state (PID files, sockets) |
| `/run/dbus` | 10M | 0755 | D-Bus daemon socket (required by gnome-keyring) |
| `/var/run` | 10M | 0755 | Legacy runtime directory |

**Total tmpfs allocation:** 632M (counted against the 4G container memory limit)

**Tuning guidance:**
- Increase `/tmp` size if large npm installs or builds fail with "No space left on device"
- Monitor tmpfs usage: `docker exec codeck-sandbox df -h | grep tmpfs`

This configuration follows Docker security best practices by restricting the attack surface for filesystem-based attacks. Any attempt to write to the root filesystem (e.g., `/app`, `/usr`, `/etc`) will fail with "Read-only file system" errors.

### Resource limits

```yaml
deploy:
  resources:
    limits:
      memory: 4G
      cpus: '2.0'
    reservations:
      memory: 512M
      cpus: '0.5'
```

Adjust `memory` and `cpus` limits based on your host system and expected workload. These defaults suit typical development use (Claude CLI + one or two dev servers).

### Health check

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost/api/auth/status"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

### Docker socket

The Docker socket (`/var/run/docker.sock`) is mounted by default in the main compose file (`docker/compose.yml`). This is required by the port-manager service for dynamic port mapping.

**What this enables:**
- Dynamic port mapping via the dashboard UI (auto-restart with new port mappings)
- Docker commands inside the container (`docker ps`, `docker compose`, etc.)
- Proactive agents can spawn sibling containers

**Risk:** Any process inside the container can create new containers, mount host filesystems, or execute commands on the host. The `cap_drop`, `no-new-privileges`, and `read_only` restrictions do not apply to containers created through the socket.

**Mitigation options:**
- **Socket proxy:** Use [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) as a sidecar that whitelists only needed Docker API endpoints.
- **Remove mount:** Edit `docker/compose.yml` to remove the Docker socket volume. Dynamic port mapping will not work, but manual `compose.override.yml` configuration is still possible.

### Volume data protection

All four named volumes (`workspace`, `codeck-data`, `claude-config`, `ssh-data`) are defined inline in the compose file. Running `docker compose down -v` will **permanently delete all data** including projects, OAuth credentials, SSH keys, and agent memory.

**Recommendation for production:** Mark critical volumes as `external: true` and create them separately:

```bash
docker volume create codeck-workspace
docker volume create codeck-data
docker volume create codeck-claude-config
docker volume create codeck-ssh-data
```

```yaml
volumes:
  workspace:
    external: true
    name: codeck-workspace
  # ... etc
```

---

## Preset System

### Available presets

| Preset | Description | Files installed |
|--------|-------------|----------------|
| `default` | Persistent memory system, rules, and sandbox skills | 9 files, 3 directories |
| `empty` | Clean slate, minimal configuration | 1 file (CLAUDE.md only) |

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
  "icon": "🔧",
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

Use `"extends": "default"` to inherit all files from the default preset. Your preset's files will overwrite matching destinations. Max chain depth: 5.

### Data file protection

Files in `memory/` paths, named `preferences.md`, or in `rules/` paths are treated as "data files". They are only copied on first apply — subsequent applies skip them to preserve user customizations. Use `POST /api/presets/reset` (force) to overwrite.

### CLAUDE.md Instruction File Hierarchy

Codeck uses a three-layer instruction file system that provides hierarchical context to the Claude agent:

#### Layer 1 (Global): `/root/.claude/CLAUDE.md`

- **Deployed by:** Preset system
- **Updated by:** Preset apply/reset only
- **Contains:** Agent operational instructions
  - Memory system rules (7 mandatory rules: read memory at session start, search before asking, write daily entries, use path-scoped memory, record decisions, never auto-promote, never write secrets)
  - Session startup sequence (read MEMORY.md, preferences.md, rules/, resolve path memory)
  - Session end sequence (write final daily entry, update path memory, create ADRs)
  - Environment info (workspace location, container details, port exposure flow)
  - Preferences and rules references
- **Source:** `apps/runtime/src/templates/presets/default/CLAUDE.md`
- **Auto-loaded:** By Claude Code CLI on every session spawn

#### Layer 2 (Workspace): `/workspace/CLAUDE.md`

- **Deployed by:** Preset system (initial template)
- **Updated by:** Git service (`updateClaudeMd()` updates project list marker only)
- **Contains:** Workspace-level rules and project listing
  - Scope boundaries (`/workspace` only, never navigate outside)
  - Port preview instructions (always bind `0.0.0.0`, check port exposure, show correct URLs)
  - Networking rules (localhost vs host.docker.internal, never show 172.x.x.x IPs)
  - Non-interactive command rules (always use `-y`, `--yes`, `--no-input` flags)
  - Auto-generated project listing via `<!-- PROJECTS_LIST -->` marker
- **Source:** `apps/runtime/src/templates/CLAUDE.md`
- **Marker-based updates:** `updateClaudeMd()` only replaces content after the `<!-- PROJECTS_LIST -->` marker, preserving user edits elsewhere

#### Layer 3 (Project): `/workspace/<project>/CLAUDE.md`

- **Managed by:** User (manual edits or cloned from git repository)
- **Contains:** Project-specific instructions
  - Tech stack and build commands
  - Project conventions and patterns
  - Development workflow
  - Known issues and TODOs
- **Example:** `/workspace/Codeck/CLAUDE.md` (this project's instructions)

#### Loading Order

Layers are loaded sequentially (1 → 2 → 3) by the Claude Code CLI:
1. **Layer 1** provides global agent rules and memory system
2. **Layer 2** provides workspace-specific rules and project navigation
3. **Layer 3** provides project-specific context and conventions

Higher layers provide foundation, lower layers provide specificity. All three layers are active simultaneously and form the complete instruction context.

#### Integration with Git & Workspace Export

**Git clone integration:**
- After successful `git clone`, `updateClaudeMd()` scans `/workspace` for `.git` directories
- Repo names are sanitized (strip non-alphanumeric except `_-. `, truncate to 100 chars)
- Project list in Layer 2 is updated: `- **repo/** - /workspace/repo`
- If Layer 2 lacks the `<!-- PROJECTS_LIST -->` marker, a warning is logged (user must re-apply preset or manually add marker)

**Workspace export:**
- All three CLAUDE.md layers are included in exports
- Layer 1 and 2: preserved as part of `.codeck/` export
- Layer 3: included naturally as part of project files
- Sensitive files excluded: `auth.json`, `sessions.json`, `.codeck/state/`

**Preset reset:**
- `POST /api/presets/reset` force-overwrites all files (including Layers 1 and 2)
- Immediately calls `updateClaudeMd()` to restore the project list in Layer 2

For detailed integration flow, see [ARCHITECTURE.md § Git + Workspace Integration Flow](ARCHITECTURE.md#git--workspace-integration-flow).

---

## CLI Permissions

Permissions control which Claude CLI tools are pre-allowed without user confirmation.

### Workspace trust dialog

Claude Code shows a "Is this a project you created or one you trust?" prompt on first use in a directory. Codeck suppresses this by writing `hasTrustDialogAccepted: true` and `hasCompletedOnboarding: true` to `/root/.claude.json` before each session spawn (see `ensureOnboardingComplete()` in `console.ts`).

**Note:** `--dangerously-skip-permissions` cannot be used because the container runs as root, and Claude Code blocks that flag for root/sudo for security reasons.

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

- Enabled permissions are synced to `/root/.claude/settings.json` `permissions.allow` array before each session spawn
- The CLI won't prompt for tools that are in the allow list
- Changes apply to **new sessions only** — existing PTY sessions are unaffected

### UI

Toggles are available in the Home dashboard under the "Permissions" card. Each toggle takes effect immediately via `POST /api/permissions`.

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

- **Dashboard:** `http://localhost`
- **Dev server preview:** `http://localhost:{port}` (e.g., `http://localhost:3000`)
- Only the Codeck port (default 80) is mapped by default. Additional ports are added via the dashboard, API, or `compose.override.yml`.

### LAN mode (all platforms)

Enable with the LAN compose override:

```bash
docker compose -f docker/compose.yml -f docker/compose.lan.yml up
```

This enables the container's built-in mDNS responder (`src/services/mdns.ts`) which broadcasts `codeck.local` and `*.codeck.local`. For full LAN discovery from other devices, also run the **host-side mDNS advertiser script**.

- **Dashboard:** `http://codeck.local`
- **Dev server preview:** `http://codeck.local:{port}` (e.g., `http://codeck.local:5173`)
- **Direct IP access:** `http://{HOST_IP}:{port}` also works
- mDNS resolution requires avahi/libnss-mdns on Linux clients, built-in on Apple devices, Android 12+

### Host-side mDNS advertiser (for LAN device access)

The host-side mDNS advertiser script is required for LAN devices (phones, tablets, other computers) to discover `codeck.local`. This works the same on all platforms (Linux, Windows, macOS).

The script lives in `scripts/mdns-advertiser.cjs` and uses `@homebridge/ciao` for full Bonjour service advertisement. This makes `codeck.local` resolvable from any device on the LAN (including Android Chrome).

**Setup (one-time):**

```powershell
cd scripts
npm install
```

**Run (requires admin — writes to hosts file):**

```powershell
# Windows (PowerShell as Administrator):
node scripts/mdns-advertiser.cjs

# macOS (Terminal):
sudo node scripts/mdns-advertiser.cjs
```

**What it does:**
1. Advertises `codeck.local` via Bonjour/mDNS so LAN devices can resolve the domain
2. Polls `http://localhost/api/ports` every 5s for active dev server ports
3. Creates per-port Bonjour services (`5173.codeck.local`, etc.)
4. Manages the hosts file (`C:\Windows\System32\drivers\etc\hosts` on Windows, `/etc/hosts` on macOS) so port subdomains also resolve on the host itself

**Hosts file entries** are managed between `# codeck-ports-start` and `# codeck-ports-end` markers. On exit (Ctrl+C), the script cleans up these entries.

**Why admin is required:** Windows mDNS cannot resolve subdomains natively. The script writes `127.0.0.1 {port}.codeck.local` entries to the hosts file. Without admin, mDNS advertisement still works for LAN devices, but `{port}.codeck.local` won't resolve on the host machine itself.

**Requirements:**
- Node.js 18+ on the host machine
- The Codeck container must be running (the script polls its API)
- The `codeck.local` base domain entry (`127.0.0.1 codeck.local`) should be in the hosts file

### LAN access security considerations

**mDNS has no authentication.** The multicast DNS protocol (RFC 6762) operates over UDP port 5353 without any form of authentication. Any device on the same network can:
- Respond to `codeck.local` queries with a fake IP address
- Intercept traffic intended for your Codeck instance
- Serve a phishing page that looks like the Codeck dashboard

**Recommended usage:**
- Only enable LAN mode on **trusted networks** (home, private office)
- **Do NOT** use LAN mode on public WiFi, coffee shops, shared coworking spaces, or any network where you don't trust all connected devices
- Consider firewall rules to restrict which devices can reach Codeck's ports

**Hosts file management (Windows/macOS):** The mDNS advertiser script requires admin/sudo privileges to write entries to the system hosts file. This is necessary because Windows and macOS don't natively resolve mDNS subdomains (like `5173.codeck.local`). Without admin, mDNS advertisement still works for other LAN devices, but port subdomains won't resolve on the host itself. The script only modifies entries between `# codeck-ports-start` and `# codeck-ports-end` markers.

**Port subdomain resolution:** `{port}.codeck.local` entries in the hosts file resolve to `127.0.0.1` (the host machine), not the actual LAN IP. This is for local development convenience only — LAN devices resolve `codeck.local` via mDNS to the host's actual LAN IP.

### Port exposure (direct mapping)

Only the Codeck port (default 80, configurable via `CODECK_PORT`) is mapped by default. Dev server ports are exposed by adding them via:
- **Dashboard UI**: Port Mapping card in the Account panel (input port + click Add)
- **API**: `POST /api/system/add-port` with `{"port": N}` (used by the agent inside the container)
- **Manual**: Edit `compose.override.yml` and restart

When a port is added via the UI or API, the system automatically:
1. Writes `compose.override.yml` on the host (via Docker helper container)
2. Saves active sessions to disk
3. Restarts the container with `docker compose up -d` (via detached helper container)
4. Sessions auto-restore on the new container

Active ports are detected by scanning listening sockets every 5 seconds and broadcast to the frontend via WebSocket with exposure status.

### Custom port ranges

Copy `compose.override.yml.example` to `compose.override.yml` and customize. Docker Compose auto-loads override files without extra `-f` flags. The auto-restart mechanism will also update this file when ports are added via the UI/API.

---

## Codeck CLI

The `codeck` CLI is a workspace package in `apps/cli/` (`@codeck/cli`) that automates setup and lifecycle management.

### Installation

```bash
npm run build:cli                # build from project root
npm link -w @codeck/cli          # link globally (optional)
```

### Commands

**`codeck init`** — Interactive setup wizard. If initialization fails (e.g., base image build error), automatically rolls back newly-created configuration files while preserving any pre-existing `.env` or `compose.override.yml`.

**`codeck restart`** — Restart the Codeck container. Includes shutdown verification: polls container status for up to 10 seconds after `docker compose down` to ensure containers fully stop before starting new ones, preventing port conflict race conditions.

### Config file

Persistent config stored at:
- **Linux/macOS:** `~/.config/codeck/config.json`
- **Windows:** `%APPDATA%\codeck\config.json`

### Config schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `projectPath` | string | `""` | Absolute path to the Codeck project directory |
| `port` | number | `80` | Webapp port |
| `extraPorts` | number[] | `[]` | Additional ports to map (e.g., `[3000, 5173]`) |
| `lanMode` | string | `"none"` | LAN access: `none`, `host` (Linux), `mdns` (Win/macOS) |
| `initialized` | boolean | `false` | Whether `codeck init` has been run |
| `os` | string | `"linux"` | Detected OS: `windows`, `macos`, `linux` |
| `lanPid` | number | — | PID of running mDNS advertiser process |

### Relationship to .env and override.yml

`codeck init` generates both `.env` and `compose.override.yml` in the project directory:

- `.env` — `CODECK_PORT`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`
- `compose.override.yml` — extra port mappings + `CODECK_MAPPED_PORTS` env var

These files are also managed at runtime by the port-manager service inside the container (for dynamic port additions via the dashboard UI). The CLI and the container both produce the same format.

---

## Local Development (without Docker)

```bash
# Install dependencies
npm install

# Start backend with hot-reload
npm run dev

# In another terminal, start frontend dev server
cd src/web && npx vite

# Frontend runs on :5173, proxies API to :8080
```

Note: `node-pty` requires C++ build tools. On macOS: `xcode-select --install`. On Linux: `build-essential`.

---

## Supply Chain Security

Codeck implements supply chain security controls to protect against compromised dependencies, base images, and build artifacts. This section covers dependency management, vulnerability scanning, and update procedures.

### Dependency Management

**Base Image Pinning:**
The base image (`node:22-slim`) is pinned to a specific SHA256 digest in `docker/Dockerfile.base` to ensure reproducible builds and prevent supply chain attacks:

```dockerfile
FROM node:22-slim@sha256:5373f1906319b3a1f291da5d102f4ce5c77ccbe29eb637f072b6c7b70443fc36
```

**To update the base image:**

1. Check for new Node.js 22.x releases: https://hub.docker.com/_/node/tags?name=22-slim
2. Pull the latest image and get its digest:
   ```bash
   docker pull node:22-slim
   docker inspect node:22-slim | grep -A 1 "RepoDigests"
   ```
3. Update the digest in `docker/Dockerfile.base` line 7
4. Rebuild base image: `docker build -t codeck-base -f docker/Dockerfile.base .`
5. Test before deploying to production

**Schedule:** Update base image digest monthly, aligned with Node.js security release schedule (typically 2nd Tuesday of each month).

**npm Package Pinning:**
- All npm dependencies are locked via `package-lock.json` (lockfile version 3)
- Claude CLI is pinned to an exact version (`@anthropic-ai/claude-code@2.1.39`)
- Security-critical packages use exact versions (e.g., `express@4.21.1`, `helmet@8.1.0`)

**Docker Official Images Provenance:**
Docker Official Images (including `node:22-slim`) include SLSA Build Level 3 provenance attestations. These attestations provide cryptographic proof of image origin and build integrity.

### Dependency Trust Model

**Trusted Publishers:**
- **Native Dependencies:** node-pty (Microsoft), better-sqlite3 (WiseLibs/joshuawise)
- **Core Runtime:** express (OpenJS Foundation), ws (websockets org)
- **Frontend:** preact (preactjs), vite (vitejs)

**Binary Artifacts:**
- better-sqlite3 prebuilt binaries: Downloaded from GitHub releases, SHA512 verified by prebuild-install
- node-pty: Compiled from source at install time (no binary downloads)

**Supply Chain Monitoring:**
- package-lock.json pins exact versions (prevents automatic malicious updates)
- Manual npm audit run before releases
- Review package-lock.json diffs in PRs for unexpected version changes

**Install Script Safety:**
Native addons (node-pty, better-sqlite3) execute install scripts during `npm install`. To audit before execution:

```bash
npm install --ignore-scripts  # Skip install scripts
npm rebuild                   # Manually rebuild after inspection
```

For production deployments, review package-lock.json changes in PRs before merging.

### Vulnerability Scanning

**Recommended Tools:**
- **Trivy** (open source, recommended) — Fast, comprehensive scanner for Docker images and npm packages
- **Grype** (open source) — Alternative to Trivy with SBOM generation
- **Docker Scout** (free tier) — Docker Inc.'s official scanner, integrated with Docker Desktop
- **Snyk** (commercial) — Developer-centric with broad CI/CD integrations

**Installation (Trivy):**
```bash
# macOS
brew install aquasecurity/trivy/trivy

# Linux
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh
```

**Usage:**
```bash
# Scan base image after building
docker build -t codeck-base -f docker/Dockerfile.base .
trivy image codeck-base

# Scan final application image
docker build -t codeck .
trivy image codeck

# Fail builds on HIGH/CRITICAL CVEs (CI/CD integration)
trivy image --exit-code 1 --severity CRITICAL,HIGH codeck-base

# Scan npm dependencies (alternative to npm audit)
npm audit --audit-level=high
```

**Recommended Scripts (add to package.json):**
```json
{
  "scripts": {
    "scan:base": "trivy image codeck-base",
    "scan:app": "trivy image codeck",
    "scan:npm": "npm audit --audit-level=high"
  }
}
```

**Scanning Schedule:**
- **Before production deploys:** Mandatory scan of final image
- **Weekly:** Automated scans via CI/CD (if using GitHub Actions or similar)
- **Monthly:** Manual review of base image CVEs alongside digest updates

### Provenance Verification

Docker Official Images include SLSA provenance attestations. Verify base image provenance before rebuilding:

**Using Cosign (Sigstore):**
```bash
# Install Cosign
brew install cosign
# OR
wget https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign-linux-amd64 && sudo mv cosign-linux-amd64 /usr/local/bin/cosign

# Verify node:22-slim provenance
cosign verify \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  --certificate-identity-regexp='^https://github.com/docker-library/' \
  docker.io/library/node:22-slim
```

**Using Docker Scout (if Docker Desktop installed):**
```bash
docker scout verify node:22-slim
```

**Verification provides:**
- Cryptographic proof the image was built by Docker Inc.'s official infrastructure
- Detection of compromised mirrors or tag-swap attacks
- Transparency log entries via Sigstore Rekor

### Update Automation (Optional)

For teams requiring proactive dependency management, consider implementing automated update notifications:

**Option 1: Renovate Bot (Recommended)**
- Supports 90+ package managers (Docker digests, npm, GitHub Actions)
- Works on GitHub, GitLab, Bitbucket, Azure DevOps
- Auto-creates PRs for dependency updates with release notes
- Dependency Dashboard for tracking update status

**Example Configuration (renovate.json):**
```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "dockerfile": {
    "enabled": true,
    "pinDigests": true
  },
  "packageRules": [
    {
      "description": "Monthly node:22-slim digest updates",
      "matchDatasources": ["docker"],
      "matchPackageNames": ["node"],
      "schedule": ["before 3am on the first day of the month"],
      "commitMessagePrefix": "chore(docker): "
    },
    {
      "description": "Weekly Claude CLI updates (manual review)",
      "matchDatasources": ["npm"],
      "matchPackageNames": ["@anthropic-ai/claude-code"],
      "automerge": false,
      "schedule": ["after 10pm every weekday"],
      "commitMessagePrefix": "chore(deps): "
    }
  ]
}
```

**Option 2: Dependabot (GitHub Native)**
- GitHub-only, 30+ package managers
- Does NOT support Docker digest updates (only tag updates)
- Simpler configuration but less flexible
- Not recommended due to lack of Docker digest support

**Option 3: Manual Quarterly Review**
- Calendar reminder for quarterly review of:
  - Node.js 22.x LTS release notes
  - Claude Code changelog and CVEs
  - npm audit results
- Document review results in GitHub issues or `docs/auditory/`
- **Recommended for personal projects** due to low overhead

### SBOM Generation (Optional)

Software Bill of Materials (SBOM) generation is recommended for distributed images or regulated environments:

```bash
# Option 1: Trivy SBOM (SPDX format)
trivy image --format spdx-json -o sbom-codeck.spdx.json codeck

# Option 2: Syft SBOM (multiple formats)
syft codeck -o spdx-json > sbom-codeck.spdx.json
syft codeck -o cyclonedx-json > sbom-codeck.cyclonedx.json

# Option 3: Docker native SBOM
docker sbom codeck
```

**SBOM Use Cases:**
- **Incident response:** Quickly determine if Codeck is affected by newly disclosed CVEs (e.g., "Does Codeck use log4j?")
- **License compliance:** Audit for GPL/copyleft dependencies
- **Vulnerability tracking:** Map historical SBOMs to future CVE disclosures

**Storage:** Commit SBOMs to `docs/sboms/` directory, tagged by version (e.g., `v0.1.0-sbom.spdx.json`).

### Read-Only Filesystem

The container runs with a read-only root filesystem (`read_only: true` in docker/compose.yml) with explicit tmpfs mounts for runtime writable directories:

```yaml
read_only: true
tmpfs:
  - /tmp:size=512M,mode=1777
  - /run:size=100M,mode=0755
  - /run/dbus:size=10M,mode=0755
  - /var/run:size=10M,mode=0755
```

This prevents malicious code from persisting filesystem modifications or installing backdoors. Each tmpfs mount has explicit size limits to prevent memory exhaustion attacks. All persistent data is stored in Docker volumes:
- `/workspace` — User projects
- `/workspace/.codeck` — Codeck configuration and agent data
- `/root/.claude` — Claude CLI credentials and config
- `/root/.ssh` — SSH keys

### References

For detailed analysis of supply chain security controls, see:
- **AUDIT-48:** Docker Hardening Regression (base image pinning, read-only filesystem)
- **AUDIT-95:** Container Image Supply Chain (provenance verification, vulnerability scanning, update automation)

Industry Standards:
- [SLSA Framework](https://slsa.dev/) — Supply-chain Levels for Software Artifacts
- [Sigstore/Cosign](https://docs.sigstore.dev/cosign/) — Keyless container signing and verification
- [OWASP NPM Security](https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html) — npm security best practices

---

## File Permissions

| File | Mode | Rationale |
|------|------|-----------|
| `/workspace/.codeck/auth.json` | `0600` | Password hash, only root should read |
| `/root/.claude/.credentials.json` | `0600` | OAuth tokens |
| `/root/.ssh/id_ed25519` | `0600` | SSH private key |
| `/root/.ssh/id_ed25519.pub` | `0644` | SSH public key (shareable) |
| `/root/.ssh/config` | `0644` | SSH configuration |
