#!/bin/bash
# Codeck statusline — sends context usage to the runtime for the web UI.
# Claude Code calls this periodically (~300ms) with JSON on stdin.
# Uses a single Python invocation that reads stdin directly (no shell interpolation).

python3 << 'PYEOF'
import sys, json, urllib.request, os

raw = sys.stdin.read()
try:
    d = json.loads(raw)
except:
    print("CTX ?")
    sys.exit(0)

# Extract context window data
cw = d.get('context_window', {})
usage = cw.get('current_usage', {})
input_tokens = usage.get('input_tokens', 0)
cache_create = usage.get('cache_creation_input_tokens', 0)
cache_read = usage.get('cache_read_input_tokens', 0)
total_tokens = input_tokens + cache_create + cache_read
window_size = cw.get('context_window_size', 0)
used_pct = cw.get('used_percentage', 0)

if not used_pct and window_size > 0:
    used_pct = round(100 * total_tokens / window_size)

# Extract model info
model = d.get('model', {})
model_name = model.get('display_name', '') or model.get('id', '')

# Send to runtime (non-blocking, fire-and-forget)
session_id = os.environ.get('CODECK_SESSION_ID', '')
payload = json.dumps({
    'contextPercent': used_pct,
    'contextTokens': total_tokens,
    'contextWindow': window_size,
    'model': model_name,
    'sessionId': session_id,
}).encode()
try:
    req = urllib.request.Request(
        'http://localhost/api/console/context',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    urllib.request.urlopen(req, timeout=1)
except:
    pass

# Output status line text (shown in terminal by Claude Code)
print(f'CTX {used_pct}%')
PYEOF
