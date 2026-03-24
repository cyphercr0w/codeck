# Notion Integration

You have access to Notion via `NOTION_API_KEY`. Use the Notion MCP tools if available.

## MCP Tools (preferred)
If `mcp__notion__*` tools are available, use them for page and database operations.

## API Fallback
```bash
# Search pages
curl -X POST https://api.notion.com/v1/search \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "search term"}'

# Get a page
curl https://api.notion.com/v1/pages/{page_id} \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28"

# Query a database
curl -X POST https://api.notion.com/v1/databases/{db_id}/query \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json"
```

## Important
- The integration must be shared with specific pages/databases in Notion settings
- Use Notion-Version header: `2022-06-28`
