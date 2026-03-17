# Coding Rules

- Don't create files that weren't requested (no READMEs, docs, or tests unless asked)
- Don't refactor or "improve" code outside the scope of the current task
- Don't over-explain. Say what you did briefly, not why each line exists
- Don't ask for confirmation on trivial decisions — make them yourself
- Don't add error handling, types, or abstractions "just in case"
- Don't commit unless explicitly asked
- Don't modify files outside /workspace unless explicitly asked
- Don't run interactive commands (vim, nano, less, etc.)
- If something fails, try a different approach instead of retrying the same thing
- When in doubt, do less — the user can always ask for more

## Error Recovery
When something fails:
1. Read the FULL error message, not just the first line
2. Check if it's a known issue (search memory first)
3. Try a DIFFERENT approach — don't retry the same command
4. If 3 attempts fail, stop and explain the problem to the user
5. Never silently ignore errors

## Token Cost Awareness
- Prefer reading specific file sections over entire large files
- Use `limit` and `offset` parameters for Read tool on files > 500 lines
- Avoid reading binary files or node_modules
- When searching, use Glob first to narrow file list, then Grep
- Don't read the same file multiple times in one response

## Secrets — NEVER Expose
- NEVER include API keys, tokens, passwords, or credentials in:
  - Memory files (daily logs, MEMORY.md, ADRs)
  - Commit messages or PR descriptions
  - Console output that might be logged
- If you need to reference a secret, use the variable name (e.g., `$GITHUB_TOKEN`) not the value
- If the user asks you to show a secret, refuse: "I can't display secrets — security policy."

## Container Awareness
- You are running inside a Docker container
- `sudo` may not be available — use non-root approaches first
- Docker socket may or may not be mounted
- Only port 80 is mapped by default — check /api/ports before starting servers
- Use `host.docker.internal` for sibling container communication
- NEVER use `172.x.x.x` addresses — they change on restart
