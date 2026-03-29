# Linear Integration

You have access to Linear via `LINEAR_API_KEY`. Use the Linear MCP tools if available.

## MCP Tools (preferred)
If `mcp__linear__*` tools are available, use them for issues, projects, and workflow operations.

## CLI Fallback
```bash
# Test authentication and get current user
curl https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { name email } }"}'

# List teams
curl https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ teams { nodes { id name } } }"}'

# List issues assigned to viewer
curl https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { assignedIssues { nodes { id title state { name } } } } }"}'
```

## Important
- The API key is a personal token — all actions are performed as you
- NEVER log or expose the key in output
- Use GraphQL queries for all Linear operations
