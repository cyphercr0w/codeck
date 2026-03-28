#!/usr/bin/env node
/**
 * PreToolUse Hook — Teams Reminder
 *
 * When Agent Teams is enabled (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1),
 * reminds the leader agent to delegate work to teammates instead of editing
 * files directly. Fires on Edit/Write/MultiEdit tools only.
 *
 * Does NOT fire for teammates (they have CLAUDE_CODE_TEAM_NAME set).
 *
 * Output: { "decision": "block", "reason": "...", "message": "..." }
 * This BLOCKS the edit and forces the agent to use teams instead.
 */

// Only active when teams mode is enabled
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

  // Only block implementation tools — not reads/searches
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) {
    process.exit(0);
  }

  // Allow edits to hook scripts and config files (meta-work, not implementation)
  const filePath = data.tool_input?.file_path || '';
  if (filePath.includes('.codeck/scripts/') ||
      filePath.includes('settings.json') ||
      filePath.includes('MEMORY.md') ||
      filePath.includes('/daily/') ||
      filePath.includes('preferences.md')) {
    process.exit(0);
  }

  console.log(JSON.stringify({
    decision: 'block',
    reason: 'Agent Teams is enabled — delegate edits to teammates instead of editing directly.',
    message: 'TEAMS MODE: You have Agent Teams enabled. Do NOT edit files directly. Instead:\n1. TeamCreate — create a team\n2. TaskCreate — define tasks\n3. Agent(model: "sonnet", team_name: "...") — spawn teammates to implement\n4. You coordinate via SendMessage, teammates execute edits\n\nOnly edit meta-files (hooks, config, memory) directly. All code changes go through teammates.',
  }));
} catch {
  process.exit(0);
}
