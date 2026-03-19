#!/bin/bash
# Custom status line for Claude Code — shows context usage and memory state.
# Outputs a single line that appears at the bottom of the terminal.

# Read hook input from stdin (JSON with session context)
INPUT=$(cat)

# Extract context usage percentage from the input if available
CONTEXT_PCT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    used = d.get('context_tokens_used', 0)
    total = d.get('context_tokens_total', 0)
    if total > 0:
        pct = int(100 * used / total)
        if pct > 80:
            print(f'⚠ CTX {pct}%')
        elif pct > 60:
            print(f'CTX {pct}%')
        else:
            print(f'CTX {pct}%')
    else:
        print('CTX ?')
except:
    print('CTX ?')
" 2>/dev/null)

# Count active sessions
SESSIONS=$(ls /workspace/.codeck/state/sessions.json 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.loads(open('/workspace/.codeck/state/sessions.json').read())
    print(len(d) if isinstance(d, list) else len(d.get('sessions', [])))
except:
    print('?')
" 2>/dev/null)

# Check if daily log was written today
TODAY=$(date +%Y-%m-%d)
if [ -f "/workspace/.codeck/memory/daily/${TODAY}.md" ]; then
    MEM="✓"
else
    MEM="○"
fi

echo "${CONTEXT_PCT} | ${SESSIONS}S | mem:${MEM}"
