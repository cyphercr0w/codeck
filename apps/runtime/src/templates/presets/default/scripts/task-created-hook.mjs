#!/usr/bin/env node
/**
 * TaskCreated Hook — Log task creation to session state for tracking.
 */
import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const subject = parsed.tool_input?.subject || parsed.task?.subject || '';
if (!subject) process.exit(0);

const STATE_DIR = '/workspace/.codeck/state';
const LOG_PATH = join(STATE_DIR, 'task-log.jsonl');
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const entry = JSON.stringify({ ts: Date.now(), type: 'created', subject });
appendFileSync(LOG_PATH, entry + '\n');
