# Slack Integration

You have access to Slack via `SLACK_BOT_TOKEN`. Use the Slack MCP tools if available.

## MCP Tools (preferred)
If `mcp__slack__*` tools are available, use them for messaging, channel operations, and user lookups.

## CLI Fallback
```bash
# Test authentication
curl https://slack.com/api/auth.test \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# List channels
curl https://slack.com/api/conversations.list \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# Post a message
curl https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "#general", "text": "Hello from Codeck!"}'
```

## Important
- The token format is `xoxb-*` (Bot User OAuth Token)
- The bot must be invited to channels before it can post or read them
- NEVER log or expose the token in output
