#!/usr/bin/env node
/**
 * PreToolUse Hook — Teams Enforcement
 *
 * When Agent Teams is enabled (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1):
 * 1. On Edit/Write/MultiEdit by the leader → soft remind to delegate
 * 2. On Agent spawn WITHOUT team_name → BLOCK and force using TeamCreate first
 *
 * Does NOT fire for teammates (they have CLAUDE_CODE_TEAM_NAME set).
 */

if (!process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
  process.exit(0);
}

// Don't block teammates — only the leader
if (process.env.CLAUDE_CODE_TEAM_NAME) {
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const data = JSON.parse(input);
  const tool = data.tool_name || '';

  // === BLOCK: Agent spawn without team_name ===
  if (tool === 'Agent') {
    const hasTeamName = data.tool_input?.team_name;
    if (!hasTeamName) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'TEAMS REQUIRED: You have Agent Teams enabled. Do NOT spawn agents without a team. First use TeamCreate to create a team, then TaskCreate to define tasks, then Agent with team_name parameter. Lone agents are not allowed when teams mode is active.',
        },
      }));
      process.exit(0);
    }
    // Has team_name — allow
    process.exit(0);
  }

  // === REMIND: Edit/Write by leader ===
  if (['Edit', 'Write', 'MultiEdit'].includes(tool)) {
    const filePath = data.tool_input?.file_path || '';
    // Allow meta-file edits silently
    if (filePath.includes('.codeck/scripts/') ||
        filePath.includes('.codeck/state/') ||
        filePath.includes('settings.json') ||
        filePath.includes('MEMORY.md') ||
        filePath.includes('/daily/') ||
        filePath.includes('/memory/') ||
        filePath.includes('preferences.md') ||
        filePath.includes('CLAUDE.md')) {
      process.exit(0);
    }

    console.log(JSON.stringify({
      message: 'TEAMS REMINDER: You have Agent Teams enabled. For multi-file changes, consider delegating to teammates via TeamCreate + Agent(model: "sonnet"). Quick fixes are OK to do directly.',
    }));
    process.exit(0);
  }

  // All other tools — allow
  process.exit(0);
} catch {
  process.exit(0);
}
