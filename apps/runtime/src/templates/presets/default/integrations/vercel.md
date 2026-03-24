# Vercel Integration

You have access to Vercel via `VERCEL_API_KEY`. Use the Vercel MCP tools if available, otherwise fall back to CLI.

## MCP Tools (preferred)
If `mcp__vercel__*` tools are available, use them directly. They handle auth automatically.

## CLI Fallback
If MCP is not available, use the Vercel CLI with `--token "$VERCEL_API_KEY"`:

```bash
# List projects
vercel project ls --token "$VERCEL_API_KEY"

# List deployments
vercel ls --token "$VERCEL_API_KEY" --scope <team-or-user>

# Deploy current directory
vercel --token "$VERCEL_API_KEY" --yes --prod

# Environment variables
vercel env ls --token "$VERCEL_API_KEY"
echo "value" | vercel env add VAR_NAME production --token "$VERCEL_API_KEY"
vercel env rm VAR_NAME production --token "$VERCEL_API_KEY"

# Domains
vercel domains ls --token "$VERCEL_API_KEY"
```

## Important
- ALWAYS pass `--token "$VERCEL_API_KEY"` — the CLI is not logged in via session
- Use `--yes` where available to avoid interactive prompts
- NEVER run bare `vercel` in a project directory — it auto-links and creates projects
- Use `--scope` to target a specific team when needed
