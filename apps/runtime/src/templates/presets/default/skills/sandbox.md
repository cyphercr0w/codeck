# Codeck Sandbox

## Your Environment

You are running inside a **Docker container** (the Codeck sandbox). Key facts:

- You have full access to the container filesystem (`/workspace/`)
- You have access to the **host's Docker daemon** via a mounted socket — you can build images, run sibling containers, and use docker compose
- **Only the Codeck port (default 80) is mapped to the host by default** — dev servers you start here are NOT reachable from the user's browser unless the port is explicitly exposed
- Sibling containers you start with `docker run -p {port}:{port}` map their ports directly to the host — no extra steps needed for those

## Port Exposure — CRITICAL

### Why this matters

The user's browser runs on the **host machine**, not inside this container. When you start a dev server on port 5173 here, the user cannot open `http://localhost:5173` unless that port is mapped through Docker to the host. This is a fundamental Docker networking constraint, not a bug.

Sibling containers you launch via `docker run -p` or `docker compose` bypass this — their ports go directly to the host.

### The rule

**Before telling the user a URL for any server you started directly in this container, you MUST verify the port is exposed.**

### Flow

1. Start the server (always bind to `0.0.0.0`)
2. Check exposure:
```bash
curl -s http://localhost/api/ports
# Returns: [{"port":5173,"exposed":true}, {"port":3000,"exposed":false}]
```

3. **If `exposed: true`** — show the URLs:
   - `http://localhost:{port}` (local)
   - `http://codeck.local:{port}` (LAN)

4. **If `exposed: false`** — you MUST ask the user before mapping:

> The server is running on port {port}, but this port isn't mapped to the host — you won't be able to open it in your browser yet.
>
> I can map port {port} for you. This requires a brief container restart (~15 seconds). Your session will save and resume automatically.
>
> Do you want me to map it?

5. **Only after the user confirms**, call the API:
```bash
curl -s -X POST http://localhost/api/system/add-port \
  -H "Content-Type: application/json" \
  -d '{"port": 5173}'
```

6. Handle the response:
   - `{"success": true, "alreadyMapped": true}` — already exposed, show URLs
   - `{"success": true}` — host mode, all ports accessible, show URLs
   - `{"success": true, "restarting": true}` — tell the user: "Mapping port {port}. The container is restarting — this takes about 15 seconds. Your session will resume automatically." **Stop and wait.** Do not run any more commands.
   - `{"success": false, "requiresRestart": true, "instructions": "..."}` — auto-restart unavailable. Tell the user the manual steps:
     > I couldn't restart automatically. To map port {port}:
     > 1. Add `- "{port}:{port}"` to `ports` in `docker/compose.override.yml`
     > 2. Add the port to `CODECK_MAPPED_PORTS` in the same file
     > 3. Run `docker compose down && docker compose up -d`

### Key rules

- **ALWAYS** bind servers to `0.0.0.0` (not `localhost` or `127.0.0.1`)
- **ALWAYS** check port exposure after starting a server
- **NEVER** show a URL for an unexposed port without the warning above
- **NEVER** map a port without asking the user first — the restart is disruptive
- **NEVER** show `172.x.x.x` addresses — Docker internal IPs, unreachable from outside
- **IGNORE** the `Local:` and `Network:` URLs printed by dev server CLIs — those are container-internal

### When you DON'T need to map a port

- **Sibling containers** started with `docker run -p {port}:{port}` or via docker compose with port mappings — their ports go directly to the host
- **Inter-service communication** inside this container — just use `localhost:{port}`

## Inter-service URLs

| Scenario | URL to use |
|----------|-----------|
| Services in this container | `localhost:{port}` |
| Sibling containers (via docker run/compose -p) | `host.docker.internal:{port}` |
| URLs for the user's browser | `localhost:{port}` (only if exposed) |
| Container IPs (172.x.x.x) | **NEVER** — they change on restart |

## Panel API

The Codeck web panel runs at `http://localhost` (port 80) and exposes a REST API:

```bash
# System status
curl http://localhost/api/status

# Network info (mode, mapped ports)
curl http://localhost/api/system/network-info

# Active ports with exposure status
curl http://localhost/api/ports

# Request port exposure (requires user confirmation first!)
curl -X POST http://localhost/api/system/add-port -H "Content-Type: application/json" -d '{"port": 3000}'
```

## Git & SSH

- SSH keys: pre-generated at `/root/.ssh/id_ed25519`
- GitHub CLI (`gh`): pre-installed, authenticate via the panel's Integrations tab
- For private repos: use SSH clone or configure HTTPS token via the panel

## Container Notes

- Node.js 22, Python 3, git, gh CLI, Docker CLI are pre-installed
- Packages installed inside projects persist across sessions (workspace is a volume)
- Global npm packages do NOT persist — always install locally
