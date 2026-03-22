---
description: "When working inside a Codeck sandbox — use this skill to configure the environment, manage integrations, and optimize your setup in real-time."
---

# Codeck Sandbox Skill

You are running inside a **Codeck sandbox** — a persistent cloud machine with a web UI, memory system, and always-on agents. You have full API access to configure your own environment.

## Available APIs

All endpoints are at `http://localhost/api/` (no auth needed from inside the container).

### Environment Variables
Environment variables are injected into every new terminal session.

```bash
# List env var keys (values are hidden)
curl -s http://localhost/api/codeck/env | jq

# Set a variable
curl -s -X POST http://localhost/api/codeck/env \
  -H 'Content-Type: application/json' \
  -d '{"key": "MY_API_KEY", "value": "sk-xxx"}'

# Delete a variable
curl -s -X DELETE http://localhost/api/codeck/env \
  -H 'Content-Type: application/json' \
  -d '{"key": "MY_API_KEY"}'
```

**Important:** Setting an env var also updates any MCP server that uses that key in its config.

### MCP Servers
MCP servers extend your capabilities (database access, web search, deployment, etc.).

```bash
# List all MCP servers (active + disabled)
curl -s http://localhost/api/mcp-servers | jq

# Add a new MCP server
curl -s -X POST http://localhost/api/mcp-servers \
  -H 'Content-Type: application/json' \
  -d '{"name": "my-server", "command": "npx", "args": ["-y", "@pkg/name"], "description": "What it does"}'

# Enable/disable a server
curl -s -X POST http://localhost/api/mcp-servers/my-server/toggle

# Remove a server
curl -s -X DELETE http://localhost/api/mcp-servers/my-server

# Search the MCP registry (12K+ servers)
curl -s 'http://localhost/api/mcp-servers/search?q=supabase' | jq
```

**When the user asks to connect a service:** Search the registry, install the server, set the API key as env var — all in one flow.

### Hooks
Hooks run scripts at specific lifecycle events (before/after tool use, on stop, etc.).

```bash
# List all hooks
curl -s http://localhost/api/hooks | jq

# Add a hook
curl -s -X POST http://localhost/api/hooks \
  -H 'Content-Type: application/json' \
  -d '{"event": "PostToolUse", "matcher": "Edit|Write", "command": "node /workspace/.codeck/scripts/my-hook.mjs"}'

# Remove a hook (by event + index)
curl -s -X DELETE http://localhost/api/hooks \
  -H 'Content-Type: application/json' \
  -d '{"event": "PostToolUse", "index": 0}'
```

Valid events: `PreToolUse`, `PostToolUse`, `Stop`, `PostCompact`

### Rules and Preferences
Rules guide your behavior. Preferences are user-specific settings.

```bash
# Add a preference (appends to preferences.md)
curl -s -X PUT http://localhost/api/codeck/files/write \
  -H 'Content-Type: application/json' \
  -d '{"path": "preferences.md", "content": "...updated content..."}'

# Add a rule (creates a new file in rules/user/)
curl -s -X PUT http://localhost/api/codeck/files/write \
  -H 'Content-Type: application/json' \
  -d '{"path": "rules/user/my-rule.md", "content": "# My Rule\n\nAlways do X."}'

# Read a file from .codeck/
curl -s 'http://localhost/api/codeck/files/read?path=preferences.md' | jq
```

### Permissions
Control which tools require user approval.

```bash
# Get current permissions
curl -s http://localhost/api/permissions | jq

# Set permissions (true = auto-allow, false = ask user)
curl -s -X POST http://localhost/api/permissions \
  -H 'Content-Type: application/json' \
  -d '{"Read": true, "Edit": true, "Write": true, "Bash": true}'
```

### Memory
Your persistent memory system. Survives across sessions.

```bash
# Search memory
curl -s 'http://localhost/api/memory/search?q=user+preferences' | jq

# Write to daily log
curl -s -X POST http://localhost/api/memory/daily \
  -H 'Content-Type: application/json' \
  -d '{"content": "## What I learned today\n\n- User prefers TypeScript..."}'

# Get memory stats
curl -s http://localhost/api/dashboard/memory-stats | jq
```

### System
```bash
# Get system info (CPU, RAM, disk, ports, sessions)
curl -s http://localhost/api/dashboard | jq

# Check exposed ports
curl -s http://localhost/api/system/network-info | jq

# Expose a port
curl -s -X POST http://localhost/api/system/add-port \
  -H 'Content-Type: application/json' \
  -d '{"port": 3000}'
```

## Self-Configuration Patterns

### When user starts a new project type:
1. Check if relevant MCP servers are available: `search?q=<technology>`
2. If found, install and configure: POST to `/api/mcp-servers`
3. Set any needed env vars: POST to `/api/codeck/env`
4. Add project-specific rules: PUT to `/api/codeck/files/write`

### When user mentions an external service:
1. Check if it's in integrations (Supabase, Vercel, Stripe, etc.)
2. If they have a token, set it as env var → MCP auto-enables
3. If not, tell them where to get the token

### When user has a recurring workflow:
1. Create a hook script in `/workspace/.codeck/scripts/`
2. Register it via POST to `/api/hooks`
3. The hook will run automatically on the specified event

### When user corrects your behavior:
1. Save the correction as a preference via `/api/codeck/files/write`
2. Save to daily log via `/api/memory/daily`
3. The preference persists across sessions

## Port Exposure
When you start a dev server, expose the port:
```bash
curl -s -X POST http://localhost/api/system/add-port \
  -H 'Content-Type: application/json' \
  -d '{"port": 3000}'
```
Then check: `curl -s http://localhost/api/ports` — if `exposed: true`, tell the user the URL.

## Key Facts
- Workspace: `/workspace/` — all project files live here
- Agent data: `/workspace/.codeck/` — memory, rules, skills, preferences
- You ARE running in a persistent Docker container — files survive restarts
- Memory persists between sessions — the user expects you to remember things
- Always bind dev servers to `0.0.0.0` (not localhost) for external access
