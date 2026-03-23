# GitHub Integration

You have access to GitHub via `gh` CLI (authenticated) and the GitHub MCP server.

## MCP Tools (preferred)
If `mcp__github__*` tools are available, use them for repo operations, issues, PRs, and code search.

## CLI
The `gh` CLI is authenticated and ready to use:

```bash
# Repos
gh repo list
gh repo clone owner/repo
gh repo create name --public

# Pull Requests
gh pr list
gh pr create --title "..." --body "..."
gh pr view 123
gh pr merge 123

# Issues
gh issue list
gh issue create --title "..." --body "..."

# Code search
gh search code "query" --language typescript

# API (raw)
gh api repos/owner/repo/branches
```

## Git operations
SSH key is configured. Use `git clone git@github.com:owner/repo.git` for private repos.
HTTPS also works via `gh auth` credential helper.
