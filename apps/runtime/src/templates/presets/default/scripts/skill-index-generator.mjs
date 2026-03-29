#!/usr/bin/env node
/**
 * Generates a compact skill index at /workspace/.codeck/state/skill-index.md
 *
 * Ultra-compact format: one line per skill grouped by category.
 * Use `/learn <skill-id>` to load full details.
 *
 * Run on SessionStart or periodically to keep the index fresh.
 */

import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = '/root/.claude/skills';
const STATE_DIR = '/workspace/.codeck/state';
const INDEX_PATH = join(STATE_DIR, 'skill-index.md');

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

if (!existsSync(SKILLS_DIR)) {
  writeFileSync(INDEX_PATH, '# Skill Index\n\nNo skills installed.\n');
  process.exit(0);
}

// Category inference from skill ID prefix
function getCategory(id) {
  if (/^(android|compose-multiplatform|flutter|foundation-models|kotlin|liquid-glass|swift|swiftui)/.test(id)) return 'mobile';
  if (/^(django|laravel|springboot|jpa|perl)/.test(id)) return 'frameworks';
  if (/^(cpp|golang|java|python|rust)/.test(id)) return 'languages';
  if (/^(frontend|nuxt4|nextjs)/.test(id)) return 'frontend';
  if (/^(backend|api|database|postgres|clickhouse|docker|deployment)/.test(id)) return 'backend';
  if (/^(agent|agentic|autonomous|claude-devfleet|continuous-agent|dmux|enterprise-agent|eval|ralphinho|team-builder)/.test(id)) return 'agents';
  if (/^(architecture|blueprint|bun|claude-api|codebase|codeck|configure|context-budget|continuous-learning|cost-aware|data-scraper|deep-research|documentation|exa-search|iterative|mcp|nanoclaw|nutrient|plankton|project-guidelines|prompt|pytorch|regex|rules|search-first|skill|strategic)/.test(id)) return 'tooling';
  if (/^(ai-first|ai-regression|tdd|e2e|testing|verification|coding-standards|code)/.test(id)) return 'quality';
  if (/^(security|django-security|laravel-security|perl-security|springboot-security)/.test(id)) return 'security';
  if (/^(article|content|crosspost|investor|market-research|video|x-api|fal-ai|videodb|visa-doc)/.test(id)) return 'content';
  if (/^(carrier|customs|energy|inventory|logistics|production-scheduling|quality-nonconformance|returns)/.test(id)) return 'supply-chain';
  return 'other';
}

const skillIds = readdirSync(SKILLS_DIR).sort().filter(dir =>
  existsSync(join(SKILLS_DIR, dir, 'SKILL.md'))
);

// Group by category
const grouped = {};
for (const id of skillIds) {
  const cat = getCategory(id);
  if (!grouped[cat]) grouped[cat] = [];
  grouped[cat].push(id);
}

const lines = [
  '# Skill Index',
  '',
  `${skillIds.length} skills. Use \`/learn <skill-id>\` to load full details.`,
  '',
];

for (const cat of Object.keys(grouped).sort()) {
  lines.push(`**${cat}:** ${grouped[cat].join(', ')}`);
  lines.push('');
}

writeFileSync(INDEX_PATH, lines.join('\n'));
console.error(`[SkillIndex] Generated compact index: ${skillIds.length} skills in ${Object.keys(grouped).length} categories`);
