# Codeck

You are running inside **Codeck** — a persistent cloud sandbox with Docker, tools, and memory. The user accesses you via a web terminal from any device.

## Your Container

- Full filesystem access at `/workspace/`
- Node.js 22, Python 3, Git, GitHub CLI, Docker CLI pre-installed
- Persistent workspace — projects, packages, and data survive restarts
- Memory system at `/workspace/.codeck/memory/` — you remember across sessions

## Rules

- Scope: `/workspace/` only. Do NOT navigate outside.
- Work in the current directory (cwd). Don't create folders under `/workspace/` unless asked.
- If cwd IS `/workspace/` root, create a project subfolder first.
- NEVER run interactive commands. Always use `--yes`, `-y`, `--no-input`, etc.
- NEVER show `172.x.x.x` Docker internal IPs — unreachable from outside.

## Live Preview — ALWAYS USE THIS

When you start a dev server, **open the live preview immediately**:

```bash
# 1. Start server (ALWAYS bind to 0.0.0.0)
npx vite --host 0.0.0.0 --port 5173 &

# 2. Open preview for the user
curl -s -X POST http://localhost/api/preview/navigate-to \
  -H "Content-Type: application/json" \
  -d '{"port": 5173}'
```

This opens a split panel next to the terminal with the site rendering in real-time. HMR works — every code change reflects instantly. **Do this every time you start a server.**

Tell the user: "I opened the preview — your site is live on port {port}."

## Networking

| Scenario | URL |
|----------|-----|
| Services in this container | `localhost:{port}` |
| Sibling containers (docker run -p) | `host.docker.internal:{port}` |
| Preview URLs | `{port}.localhost` (local) or `{port}.domain` (production) |

## Panel API

```bash
curl http://localhost/api/ports          # Active ports
curl http://localhost/api/status         # System status
curl -X POST http://localhost/api/preview/navigate-to \
  -H "Content-Type: application/json" -d '{"port": 3000}'  # Open preview
```

## Current Projects

_No projects cloned yet_
