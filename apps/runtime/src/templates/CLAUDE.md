# Codeck

You are running inside a sandboxed Docker container with persistent workspace and tools.

## Workspace Layout

```
/workspace/
  ├── .codeck/                       # Agent data (memory, rules, skills, preferences)
  ├── CLAUDE.md                        # This file (workspace rules + project listing)
  └── <projects>/                       # User projects
```

## Rules

- Your scope is `/workspace`. Do NOT navigate outside `/workspace`.
- Work inside your current working directory (cwd). The user chose this directory when opening the session — respect it. Do NOT create new folders under /workspace/ unless the user explicitly asks for a new project elsewhere.
- If your cwd IS /workspace/ root, then create a project subfolder (e.g., /workspace/{project-name}/) — never scatter files in the root.
- NEVER run interactive commands. Always use non-interactive flags: `--yes`, `--no-input`, `--default`, `-y`, etc. Examples:
  - `npx create-next-app@latest my-app --yes --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"` (NOT bare `create-next-app`)
  - `pnpm init` (already non-interactive)
  - `git commit -m "msg"` (NOT `git commit` without -m)
  If a CLI tool has no non-interactive flag, create files manually instead.

## Dev Server Preview

You are inside a Docker container. **Only the Codeck port (default 80) is mapped by default.**

**Starting servers — ALWAYS bind to `0.0.0.0`:**
- `npx vite --host 0.0.0.0`, `next dev -H 0.0.0.0`, `python -m http.server --bind 0.0.0.0`
- Without `0.0.0.0`, the server is unreachable from outside the container.

**After starting any dev server, you MUST check if the port is exposed:**
```bash
curl -s http://localhost/api/ports
```
- If `exposed: true` → show `http://localhost:{port}` (local) + `http://codeck.local:{port}` (LAN)
- If `exposed: false` → call `POST http://localhost/api/system/add-port` with `{"port": N}` and follow the response instructions

See `/workspace/.codeck/skills/sandbox.md` for the full port exposure flow.

NEVER show `172.x.x.x` addresses — Docker internal, unreachable from outside.

## Inter-service URLs

- **Same container** (services you started directly): `localhost:{port}`
- **Sibling containers** (started via `docker run`/`docker compose`): `host.docker.internal:{port}`
- **NEVER** use `172.x.x.x` container IPs — they change on restart and are unreachable from outside Docker

## Current Projects

<!-- PROJECTS_LIST (auto-generated, do not edit manually) -->
_No projects cloned yet_
