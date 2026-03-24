# Supabase Integration

You have access to Supabase via `SUPABASE_ACCESS_TOKEN`. Use the Supabase MCP tools if available.

## MCP Tools (preferred)
If `mcp__supabase__*` tools are available, use them for database operations, auth, storage, and edge functions.

## CLI Fallback
```bash
# Install if not available
npx supabase --version

# Login (uses token from env)
export SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN"

# List projects
npx supabase projects list

# Database
npx supabase db push
npx supabase db pull
npx supabase migration new <name>

# Functions
npx supabase functions deploy <name>
npx supabase functions list
```

## Direct API
```bash
# Use the Management API with the access token
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  https://api.supabase.com/v1/projects
```
