#!/usr/bin/env node
/**
 * Team event tracker — handles TeammateIdle and TaskCompleted hook events.
 * Updates /workspace/.codeck/state/team-activity.json with current state.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const STATE_DIR = '/workspace/.codeck/state';
const STATE_FILE = `${STATE_DIR}/team-activity.json`;
const MAX_ENTRIES = 50;

try {
  const input = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
    setTimeout(() => resolve(null), 2000);
  });

  if (!input) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Determine event type
  const isTaskCompleted = input.task_id && input.task_subject;
  const isTeammateIdle = input.teammate_name && !input.task_id;

  if (!isTaskCompleted && !isTeammateIdle) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Ensure state directory exists
  mkdirSync(STATE_DIR, { recursive: true });

  // Read existing state
  let state = { tasks: [], teammates: {} };
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    state = JSON.parse(raw);
    if (!state.tasks) state.tasks = [];
    if (!state.teammates) state.teammates = {};
  } catch {
    // File doesn't exist yet — start fresh
  }

  let eventType;
  let message;

  if (isTaskCompleted) {
    eventType = 'TaskCompleted';
    const entry = {
      task_id: input.task_id,
      task_subject: input.task_subject,
      teammate_name: input.teammate_name || 'unknown',
      completed_at: new Date().toISOString(),
    };
    state.tasks.push(entry);
    // Keep max 50 entries — remove oldest
    if (state.tasks.length > MAX_ENTRIES) {
      state.tasks = state.tasks.slice(state.tasks.length - MAX_ENTRIES);
    }
    message = `[Team] Task '${input.task_subject}' completed by ${entry.teammate_name}`;
  } else {
    // TeammateIdle
    eventType = 'TeammateIdle';
    state.teammates[input.teammate_name] = {
      teammate_name: input.teammate_name,
      status: 'idle',
      last_seen: new Date().toISOString(),
    };
    message = `[Team] ${input.teammate_name} is now idle and available for new tasks`;
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventType,
      additionalContext: message,
    },
  }));
} catch {
  // Never block Claude Code
  process.stdout.write(JSON.stringify({}));
}

process.exit(0);
