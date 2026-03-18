#!/usr/bin/env node

/**
 * PreToolUse Hook (Bash) — Block dangerous commands.
 *
 * Catches destructive patterns like rm -rf /, DROP TABLE, force push to main,
 * fork bombs, and piping untrusted URLs to bash. Exit code 2 = hard block.
 */

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const cmd = parsed.tool_input?.command || '';
if (!cmd) {
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

const BLOCKED = [
  // Filesystem destruction
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/, msg: 'rm on root filesystem' },
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?~($|\s)/, msg: 'rm on home directory' },
  { pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\.\s*$/, msg: 'rm -r on current directory' },

  // Database destruction
  { pattern: /DROP\s+(TABLE|DATABASE)\s/i, msg: 'DROP TABLE/DATABASE' },
  { pattern: /TRUNCATE\s+TABLE/i, msg: 'TRUNCATE TABLE' },
  { pattern: /DELETE\s+FROM\s+\w+\s*;?\s*$/i, msg: 'DELETE without WHERE clause' },

  // Git destructive operations on main/master
  { pattern: /git\s+push\s+.*--force(?!-with-lease).*\s+(main|master)\b/i, msg: 'force push to main/master' },
  { pattern: /git\s+push\s+-f\s+(origin\s+)?(main|master)\b/i, msg: 'force push to main/master' },
  { pattern: /git\s+reset\s+--hard\s+origin/i, msg: 'hard reset to remote (destroys local changes)' },

  // System destruction
  { pattern: /mkfs\./i, msg: 'filesystem format command' },
  { pattern: />\s*\/dev\/sd/i, msg: 'write to block device' },
  { pattern: /dd\s+if=.*of=\/dev\//i, msg: 'dd to block device' },
  { pattern: /:\(\)\{\s*:\|:&\s*\};:/, msg: 'fork bomb' },

  // Permission escalation
  { pattern: /chmod\s+(-R\s+)?777\s+\//i, msg: 'chmod 777 on root' },
  { pattern: /chown\s+-R\s+.*\s+\/($|\s)/i, msg: 'chown on root filesystem' },

  // Remote code execution
  { pattern: /curl\s+[^|]*\|\s*(sudo\s+)?bash/i, msg: 'piping curl to bash' },
  { pattern: /wget\s+[^|]*\|\s*(sudo\s+)?bash/i, msg: 'piping wget to bash' },
  { pattern: /curl\s+[^|]*\|\s*(sudo\s+)?sh/i, msg: 'piping curl to sh' },
  { pattern: /wget\s+[^|]*\|\s*(sudo\s+)?sh/i, msg: 'piping wget to sh' },
];

for (const { pattern, msg } of BLOCKED) {
  if (pattern.test(cmd)) {
    process.stderr.write(`BLOCKED: Dangerous command detected (${msg}). Use a safer approach.`);
    process.exit(2);
  }
}

// Approve
console.log(JSON.stringify({ result: 'approve' }));
