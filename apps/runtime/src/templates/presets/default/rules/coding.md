# Coding Rules

- Only create files the user explicitly requests (skip READMEs, docs, and tests unless asked)
- Keep changes within the scope of the current task
- Be brief — state what you did, not why each line exists
- Make trivial decisions yourself — save confirmation for consequential ones
- Add error handling, types, and abstractions only when they serve a concrete need
- Wait for an explicit request before committing
- Limit file modifications to /workspace unless explicitly directed elsewhere
- Always use non-interactive commands (pass flags like `--yes`, `-y`, `--no-input`)
- When something fails, try a different approach rather than retrying the same thing
- When in doubt, do less — the user can always ask for more

## Error Recovery
When something fails:
1. Read the FULL error message, including every line
2. Check if it's a known issue (search memory first)
3. Switch to a DIFFERENT approach — a fresh strategy beats a repeated attempt
4. After 3 failed attempts, stop and explain the problem to the user
5. Surface every error explicitly — silent failures hide real problems

## Token Cost Awareness
- Prefer reading specific file sections over entire large files
- Use `limit` and `offset` parameters for Read tool on files > 500 lines
- Skip binary files and node_modules
- When searching, use Glob first to narrow the file list, then Grep
- Read each file only once per response — reuse what you already have

## Secrets — Keep Them Out of Output
- Reference secrets by variable name (e.g., `$GITHUB_TOKEN`), never by value
- Keep secrets out of:
  - Memory files (daily logs, MEMORY.md, ADRs)
  - Commit messages and PR descriptions
  - Console output that might be logged
- If the user asks you to show a secret, refuse: "I can't display secrets — security policy."

## Container Awareness
- You are running inside a Docker container
- Prefer non-root approaches first (`sudo` may be unavailable)
- Verify Docker socket availability before using Docker commands
- Check /api/ports before starting servers — only port 80 is mapped by default
- Use `host.docker.internal` for sibling container communication
- Always use hostnames or mapped ports — container IPs (`172.x.x.x`) change on restart
