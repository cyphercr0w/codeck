#!/usr/bin/env node

/**
 * SessionStart Hook — Config Watcher Registration
 *
 * Registers paths to watch for changes. When any of these files change,
 * the config-changed.mjs hook will be triggered with the updated content
 * injected as additionalContext so the model is aware of the change.
 */

let input = '';
for await (const chunk of process.stdin) input += chunk;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    watchPaths: [
      '/workspace/.codeck/config.json',
      '/workspace/.codeck/preferences.md',
      '/workspace/.codeck/memory/MEMORY.md'
    ]
  }
}));
