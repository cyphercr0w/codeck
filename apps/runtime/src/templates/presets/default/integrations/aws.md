# AWS Integration

You have access to AWS via `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_REGION`. Use the AWS MCP tools if available.

## MCP Tools (preferred)
If `mcp__aws__*` tools are available, use them for S3, Lambda, DynamoDB, and other AWS service operations.

## CLI Fallback
```bash
# Configure AWS CLI (uses env vars automatically)
export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
export AWS_REGION="${AWS_REGION:-us-east-1}"

# Test authentication
aws sts get-caller-identity

# List S3 buckets
aws s3 ls

# List Lambda functions
aws lambda list-functions --region "$AWS_REGION"

# Query DynamoDB table
aws dynamodb list-tables --region "$AWS_REGION"
```

## Important
- `AWS_ACCESS_KEY_ID` starts with `AKIA` (long-term) or `ASIA` (temporary session)
- Always set `AWS_REGION` to target the correct region
- NEVER log or expose the secret key in output
- Prefer least-privilege IAM policies — only request permissions you need
- Use test/staging environments before running destructive operations in production
