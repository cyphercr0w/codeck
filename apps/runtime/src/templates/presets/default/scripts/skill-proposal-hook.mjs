#!/usr/bin/env node
/**
 * Stop Hook — Skill Auto-Proposal
 *
 * At session end, extracts tool sequences and command patterns.
 * When a pattern appears in 3+ sessions, proposes a new skill.
 * Writes proposals to /workspace/.codeck/state/skill-proposals.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const PROPOSALS_PATH = join(STATE_DIR, 'skill-proposals.json');
const PATTERNS_PATH = join(STATE_DIR, 'workflow-patterns.json');

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const transcript = parsed.transcript || parsed.conversation || '';
if (!transcript || typeof transcript !== 'string' || transcript.length < 500) process.exit(0);

// Extract command patterns (repeated bash commands)
const bashCommands = [];
const bashRegex = /command['":\s]+["']([^"']+)["']/g;
let match;
while ((match = bashRegex.exec(transcript)) !== null) {
  const cmd = match[1].trim();
  // Normalize: strip args, keep base command
  const base = cmd.split(/\s+/).slice(0, 3).join(' ');
  if (base.length > 5 && base.length < 100) bashCommands.push(base);
}

// Extract tool sequences (what tools were used in what order)
const toolSequence = [];
const toolRegex = /tool_name['":\s]+["'](\w+)["']/g;
while ((match = toolRegex.exec(transcript)) !== null) {
  toolSequence.push(match[1]);
}

// Build a signature from the most common commands and tool pairs
const cmdCounts = {};
for (const cmd of bashCommands) {
  cmdCounts[cmd] = (cmdCounts[cmd] || 0) + 1;
}
const repeatedCmds = Object.entries(cmdCounts)
  .filter(([, count]) => count >= 2)
  .map(([cmd]) => cmd)
  .slice(0, 5);

if (repeatedCmds.length === 0 && toolSequence.length < 5) process.exit(0);

// Generate a pattern signature
const signature = repeatedCmds.sort().join('|') || toolSequence.slice(0, 10).join(',');

// Load existing patterns
let patterns = {};
try {
  if (existsSync(PATTERNS_PATH)) {
    patterns = JSON.parse(readFileSync(PATTERNS_PATH, 'utf-8'));
  }
} catch { /* start fresh */ }

// Update pattern count
if (!patterns[signature]) {
  patterns[signature] = { count: 0, commands: repeatedCmds, firstSeen: new Date().toISOString() };
}
patterns[signature].count++;
patterns[signature].lastSeen = new Date().toISOString();

// Write patterns
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2));

// Check for proposals (3+ occurrences)
const newProposals = [];
for (const [sig, data] of Object.entries(patterns)) {
  if (data.count >= 3 && !data.proposed) {
    newProposals.push({
      signature: sig,
      commands: data.commands,
      occurrences: data.count,
      firstSeen: data.firstSeen,
      proposedAt: new Date().toISOString(),
      suggestion: `Repeated workflow detected (${data.count} sessions): ${data.commands.join(', ')}. Consider creating a skill or command to automate this.`,
    });
    patterns[sig].proposed = true;
  }
}

if (newProposals.length > 0) {
  // Append to proposals file
  let proposals = [];
  try {
    if (existsSync(PROPOSALS_PATH)) {
      proposals = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8'));
    }
  } catch { /* start fresh */ }
  proposals.push(...newProposals);
  writeFileSync(PROPOSALS_PATH, JSON.stringify(proposals, null, 2));
  writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2));
}
