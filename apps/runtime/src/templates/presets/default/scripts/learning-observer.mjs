#!/usr/bin/env node

/**
 * PostToolUse Hook — Observe tool failures for continuous learning.
 *
 * Logs tool failures to an observations file. The /review-learnings
 * or /evolve command can later analyze these observations to suggest
 * new rules or skills.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name;
const toolResult = parsed.tool_result;

// Only log failures — successful operations are not interesting for learning
if (!toolResult) process.exit(0);

const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

// Detect failure patterns
const isFailure =
  resultStr.includes('Error:') ||
  resultStr.includes('error:') ||
  resultStr.includes('FAILED') ||
  resultStr.includes('Exit code') ||
  resultStr.includes('Permission denied') ||
  resultStr.includes('not found') ||
  resultStr.includes('No such file');

if (!isFailure) process.exit(0);

const stateDir = '/workspace/.codeck/state';
const obsPath = join(stateDir, 'learning-observations.jsonl');

if (!existsSync(stateDir)) {
  mkdirSync(stateDir, { recursive: true });
}

const observation = {
  timestamp: new Date().toISOString(),
  tool: toolName,
  file: parsed.tool_input?.file_path || parsed.tool_input?.command?.slice(0, 100) || null,
  error: resultStr.slice(0, 300),
};

try {
  appendFileSync(obsPath, JSON.stringify(observation) + '\n');

  // Cap at 500 entries — trim oldest
  const content = readFileSync(obsPath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length > 500) {
    writeFileSync(obsPath, lines.slice(-500).join('\n') + '\n');
  }
} catch { /* non-fatal — never block */ }

process.exit(0);
