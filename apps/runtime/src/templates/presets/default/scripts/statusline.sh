#!/bin/bash
# Codeck statusline — sends context usage to the runtime for the web UI.
# Claude Code calls this periodically (~300ms) with JSON on stdin.

INPUT=$(cat)

# Extract context data and push to runtime
python3 -c "
import sys, json, urllib.request

try:
    d = json.loads('''$INPUT''')
except:
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

# Calculate percentage if not provided natively
if not used_pct and window_size > 0:
    used_pct = round(100 * total_tokens / window_size)

# Extract model info
model = d.get('model', {})
model_name = model.get('display_name', '') or model.get('id', '')

# Send to runtime (localhost, no auth needed for internal endpoints)
if used_pct or total_tokens:
    payload = json.dumps({
        'contextPercent': used_pct,
        'contextTokens': total_tokens,
        'contextWindow': window_size,
        'model': model_name,
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
" 2>/dev/null

# Output status line text (shown in terminal)
CTX=$(python3 -c "
import json, sys
try:
    d = json.loads('''$INPUT''')
    cw = d.get('context_window', {})
    pct = cw.get('used_percentage', 0)
    if not pct:
        u = cw.get('current_usage', {})
        t = u.get('input_tokens',0) + u.get('cache_creation_input_tokens',0) + u.get('cache_read_input_tokens',0)
        w = cw.get('context_window_size', 0)
        pct = round(100*t/w) if w else 0
    print(f'CTX {pct}%')
except:
    print('CTX ?')
" 2>/dev/null)

echo "$CTX"
