#!/usr/bin/env node
/**
 * PreToolUse Hook — Teams Reminder
 *
 * When Agent Teams is enabled (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1):
 * 1. On Edit/Write/MultiEdit by the leader → soft remind to delegate
 * 2. On Agent spawn → soft remind to give a complete brief and a `name`
 *
 * Since Claude Code 2.1.178, Agent Teams is IMPLICIT: TeamCreate/TeamDelete
 * were removed and every session is already a team. Teammates are spawned via
 * the Agent tool's `name` param (the old `team_name` param is accepted but
 * ignored). This hook therefore only reminds — it never blocks on team_name.
 *
 * Does NOT fire for teammates (they have CLAUDE_CODE_TEAM_NAME set).
 */

// Only active when teams is enabled.
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

  // === REMIND: Agent spawn without a name ===
  // Implicit teams (2.1.178+): a named Agent becomes a persistent teammate.
  // Never block — only nudge the leader to name teammates and brief them fully.
  if (tool === 'Agent') {
    const hasName = data.tool_input?.name;
    if (!hasName) {
      console.log(JSON.stringify({
        message: 'TEAMS TIP: Give this teammate a unique `name` so you can track and SendMessage it. Include a complete brief (exact file paths, decisions, what to verify) — teammates start with an isolated context.',
      }));
    }
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
      message: 'TEAMS REMINDER: You have Agent Teams enabled. For multi-file changes, consider delegating to a teammate via Agent(name: "...", model: "sonnet"). Quick fixes are OK to do directly.',
    }));
    process.exit(0);
  }

  // All other tools — allow
  process.exit(0);
} catch {
  process.exit(0);
}
