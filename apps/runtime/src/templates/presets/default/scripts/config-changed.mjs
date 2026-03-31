#!/usr/bin/env node

/**
 * FileChanged Hook — Config Change Notification
 *
 * Triggered when a watched config file changes. Reads the updated file
 * content and injects it as additionalContext so the model stays in sync
 * with the latest config/preferences/memory without needing to re-read.
 */

import { readFileSync } from 'fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let filePath = '';
let content = '';

try {
  const parsed = JSON.parse(input);
  filePath = parsed.file_path || '';

  if (filePath) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      content = raw.slice(0, 2000);
    } catch {
      content = '(could not read file)';
    }
  }
} catch {
  // Non-fatal: malformed input
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'FileChanged',
    additionalContext: `Config file changed: ${filePath}\nUpdated content (first 2000 chars):\n${content}`
  }
}));
