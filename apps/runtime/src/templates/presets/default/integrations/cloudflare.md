# Cloudflare Integration

You have access to Cloudflare via `CLOUDFLARE_API_TOKEN`. Use the Cloudflare MCP tools if available.

## MCP Tools (preferred)
If `mcp__cloudflare__*` tools are available, use them.

## API Fallback
```bash
# List zones (domains)
curl https://api.cloudflare.com/client/v4/zones \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# DNS records for a zone
curl https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Workers
curl https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Pages projects
curl https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```
