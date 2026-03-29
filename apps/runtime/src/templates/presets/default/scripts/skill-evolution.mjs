#!/usr/bin/env node
/**
 * Skill Evolution — Closed Learning Loop
 *
 * Reads skill-metrics.json to identify underperforming skills (high error/retry rates).
 * Generates improvement suggestions to /workspace/.codeck/state/skill-improvements.md.
 *
 * Run manually: node /workspace/.codeck/scripts/skill-evolution.mjs
 * Or schedule via cron: runs weekly to audit skill health.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const METRICS_PATH = join(STATE_DIR, 'skill-metrics.json');
const OUTPUT_PATH = join(STATE_DIR, 'skill-improvements.md');

if (!existsSync(METRICS_PATH)) {
  console.log('[SkillEvolution] No metrics found yet. Run some sessions first.');
  process.exit(0);
}

let metrics;
try {
  metrics = JSON.parse(readFileSync(METRICS_PATH, 'utf-8'));
} catch (e) {
  console.error('[SkillEvolution] Failed to read metrics:', e.message);
  process.exit(1);
}

if (!metrics.skills || Object.keys(metrics.skills).length === 0) {
  console.log('[SkillEvolution] No skill usage data yet.');
  process.exit(0);
}

const now = new Date();
const report = [`# Skill Evolution Report`, `Generated: ${now.toISOString()}`, `Sessions analyzed: ${metrics.sessions}`, ''];

const issues = [];
const healthy = [];

for (const [name, data] of Object.entries(metrics.skills)) {
  if (!data.sessions || data.sessions.length === 0) continue;

  // Calculate averages from recent sessions
  const recent = data.sessions.slice(-10);
  const avgErrors = recent.reduce((sum, s) => sum + (s.errors || 0), 0) / recent.length;
  const avgRetries = recent.reduce((sum, s) => sum + (s.retries || 0), 0) / recent.length;
  const avgCorrections = recent.reduce((sum, s) => sum + (s.corrections || 0), 0) / recent.length;

  const score = Math.max(0, 100 - (avgErrors * 5) - (avgRetries * 10) - (avgCorrections * 20));

  if (score < 60) {
    issues.push({
      name,
      score: Math.round(score),
      loads: data.loads,
      avgErrors: avgErrors.toFixed(1),
      avgRetries: avgRetries.toFixed(1),
      avgCorrections: avgCorrections.toFixed(1),
      suggestions: generateSuggestions(name, avgErrors, avgRetries, avgCorrections),
    });
  } else {
    healthy.push({ name, score: Math.round(score), loads: data.loads });
  }
}

// Sort by worst score first
issues.sort((a, b) => a.score - b.score);

if (issues.length > 0) {
  report.push('## Underperforming Skills (score < 60)', '');
  for (const issue of issues) {
    report.push(`### ${issue.name} — Score: ${issue.score}/100`);
    report.push(`- Loads: ${issue.loads} | Avg errors: ${issue.avgErrors} | Avg retries: ${issue.avgRetries} | Avg corrections: ${issue.avgCorrections}`);
    report.push('- **Suggestions:**');
    for (const s of issue.suggestions) {
      report.push(`  - ${s}`);
    }
    report.push('');
  }
} else {
  report.push('## All skills healthy (score >= 60)', '');
}

if (healthy.length > 0) {
  report.push('## Healthy Skills', '');
  report.push('| Skill | Score | Loads |');
  report.push('|-------|-------|-------|');
  for (const h of healthy.sort((a, b) => b.score - a.score)) {
    report.push(`| ${h.name} | ${h.score}/100 | ${h.loads} |`);
  }
}

// Agent metrics
if (metrics.agents && Object.keys(metrics.agents).length > 0) {
  report.push('', '## Agent Usage', '');
  report.push('| Agent | Spawns |');
  report.push('|-------|--------|');
  const sorted = Object.entries(metrics.agents).sort((a, b) => b[1].spawns - a[1].spawns);
  for (const [name, data] of sorted) {
    report.push(`| ${name} | ${data.spawns} |`);
  }
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(OUTPUT_PATH, report.join('\n'));
console.log(`[SkillEvolution] Report written to ${OUTPUT_PATH}`);
console.log(`  Skills analyzed: ${issues.length + healthy.length}`);
console.log(`  Issues found: ${issues.length}`);

function generateSuggestions(name, errors, retries, corrections) {
  const suggestions = [];
  if (corrections > 1) {
    suggestions.push('High user corrections — skill instructions may be unclear or misaligned with user expectations. Review and rewrite key rules.');
  }
  if (retries > 2) {
    suggestions.push('High retry rate — skill may be attempting approaches that fail. Add explicit error handling guidance or alternative approaches.');
  }
  if (errors > 5) {
    suggestions.push('High error rate — check if the skill references tools/APIs that have changed. Update with current syntax.');
  }
  if (suggestions.length === 0) {
    suggestions.push('Review skill instructions for clarity and add a Gotchas section with known failure modes.');
  }
  return suggestions;
}
