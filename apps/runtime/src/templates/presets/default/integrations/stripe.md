# Stripe Integration

You have access to Stripe via `STRIPE_SECRET_KEY`. Use the Stripe MCP tools if available.

## MCP Tools (preferred)
If `mcp__stripe__*` tools are available, use them for payments, subscriptions, and invoice operations.

## CLI Fallback
```bash
# Use curl with the secret key
curl https://api.stripe.com/v1/customers \
  -u "$STRIPE_SECRET_KEY:" \
  -d "email=test@example.com"

# List recent charges
curl https://api.stripe.com/v1/charges?limit=5 \
  -u "$STRIPE_SECRET_KEY:"

# List products
curl https://api.stripe.com/v1/products?limit=10 \
  -u "$STRIPE_SECRET_KEY:"
```

## Important
- The key format `sk_test_*` = test mode, `sk_live_*` = production
- NEVER log or expose the key in output
- Use test mode keys during development
