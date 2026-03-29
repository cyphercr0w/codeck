#!/usr/bin/env node
/**
 * Stop Hook — Skill Performance Metrics
 *
 * At session end, reads the conversation transcript to identify:
 * - Which skills were loaded (/learn commands)
 * - Which agents were spawned (Agent tool calls)
 * - Success/failure signals (errors, retries, user corrections)
 *
 * Appends metrics to a JSON file for long-term tracking.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const SESSIONS_DIR = '/workspace/.codeck/sessions';
const METRICS_PATH = join(STATE_DIR, 'skill-metrics.json');

const APPROVE = JSON.stringify({ result: 'approve' });

let _approved = false;
function exitApprove() {
  if (!_approved) { _approved = true; process.stdout.write(APPROVE); }
  process.exit(0);
}

async function main() {
  let payload;
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    payload = JSON.parse(input);
  } catch {
    exitApprove();
  }

  const sessionId = payload?.session_id;
  if (!sessionId) exitApprove();

  // Read transcript from session file
  const transcriptPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) exitApprove();

  let transcript = '';
  try {
    transcript = readFileSync(transcriptPath, 'utf-8');
  } catch {
    exitApprove();
  }

  if (!transcript.trim()) exitApprove();

  // Parse skill loads from /learn commands in user messages
  const skillLoads = [];
  const skillRegex = /\/learn\s+([\w-]+)/g;
  let match;
  while ((match = skillRegex.exec(transcript)) !== null) {
    skillLoads.push(match[1]);
  }

  // Parse agent spawns from subagent_type fields in tool calls
  const agentSpawns = [];
  const agentRegex = /subagent_type["']?\s*[:=]\s*["']?([\w-]+)/g;
  while ((match = agentRegex.exec(transcript)) !== null) {
    agentSpawns.push(match[1]);
  }

  // Count error/retry/correction signals as quality indicators
  const errorSignals = (transcript.match(/error|Error|ERROR|failed|Failed|FAIL/g) || []).length;
  const retrySignals = (transcript.match(/retry|Retry|retrying|try again/gi) || []).length;
  const correctionSignals = (transcript.match(/no[,.]?\s+(?:don't|not|use|instead)/gi) || []).length;

  if (skillLoads.length === 0 && agentSpawns.length === 0) exitApprove();

  // Load existing metrics or start fresh
  let metrics = { sessions: 0, skills: {}, agents: {}, lastUpdated: null };
  try {
    if (existsSync(METRICS_PATH)) {
      metrics = JSON.parse(readFileSync(METRICS_PATH, 'utf-8'));
    }
  } catch { /* start fresh */ }

  metrics.sessions = (metrics.sessions || 0) + 1;
  metrics.lastUpdated = new Date().toISOString();

  // Update skill metrics
  for (const skill of skillLoads) {
    if (!metrics.skills[skill]) {
      metrics.skills[skill] = { loads: 0, sessions: [] };
    }
    metrics.skills[skill].loads++;
    metrics.skills[skill].sessions.push({
      date: metrics.lastUpdated,
      errors: errorSignals,
      retries: retrySignals,
      corrections: correctionSignals,
    });
    // Keep only last 20 sessions per skill
    if (metrics.skills[skill].sessions.length > 20) {
      metrics.skills[skill].sessions = metrics.skills[skill].sessions.slice(-20);
    }
  }

  // Update agent metrics
  for (const agent of agentSpawns) {
    if (!metrics.agents[agent]) {
      metrics.agents[agent] = { spawns: 0 };
    }
    metrics.agents[agent].spawns++;
  }

  // Write metrics
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2));

  console.error(`[SkillMetrics] Updated metrics: ${skillLoads.length} skills, ${agentSpawns.length} agents`);
  exitApprove();
}

main().catch(() => exitApprove());
