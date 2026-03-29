#!/usr/bin/env node
/**
 * StopFailure Hook — Log API failures for diagnostics.
 */
import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const reason = parsed.reason || parsed.error || 'unknown';

const STATE_DIR = '/workspace/.codeck/state';
const LOG_PATH = join(STATE_DIR, 'failures.jsonl');
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const entry = JSON.stringify({ ts: Date.now(), type: 'stop_failure', reason });
appendFileSync(LOG_PATH, entry + '\n');

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'StopFailure',
    additionalContext: `Session ended due to error: ${reason}. Check /workspace/.codeck/state/failures.jsonl for history.`,
  }
}));
