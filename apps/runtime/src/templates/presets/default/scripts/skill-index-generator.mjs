#!/usr/bin/env node
/**
 * Generates a compact skill index at /workspace/.codeck/state/skill-index.md
 *
 * Progressive disclosure: instead of Claude loading full SKILL.md files (some 30KB),
 * this index provides name + description for all 100+ skills in ~5KB. Claude reads
 * the index to find relevant skills, then reads only the specific SKILL.md it needs.
 *
 * Run on SessionStart or periodically to keep the index fresh.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = '/root/.claude/skills';
const STATE_DIR = '/workspace/.codeck/state';
const INDEX_PATH = join(STATE_DIR, 'skill-index.md');
const MAX_SKILL_SIZE = 4096; // skills larger than this get a summary note

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

if (!existsSync(SKILLS_DIR)) {
  writeFileSync(INDEX_PATH, '# Skill Index\n\nNo skills installed.\n');
  process.exit(0);
}

const skills = [];

for (const dir of readdirSync(SKILLS_DIR).sort()) {
  const skillMd = join(SKILLS_DIR, dir, 'SKILL.md');
  if (!existsSync(skillMd)) continue;

  try {
    const content = readFileSync(skillMd, 'utf-8');
    const size = content.length;

    // Extract frontmatter
    let name = dir;
    let description = '';
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    // If no description in frontmatter, use first non-empty line after frontmatter
    if (!description) {
      const afterFm = content.replace(/^---[\s\S]*?---\n*/, '');
      const firstLine = afterFm.split('\n').find(l => l.trim() && !l.startsWith('#'));
      if (firstLine) description = firstLine.trim().slice(0, 120);
    }

    skills.push({
      id: dir,
      name,
      description: description.slice(0, 150),
      size,
      large: size > MAX_SKILL_SIZE,
    });
  } catch { /* skip broken skills */ }
}

// Generate compact markdown index
const lines = [
  '# Skill Index',
  '',
  `${skills.length} skills available. Use \`/learn <skill-id>\` to load one.`,
  '',
  '| Skill | Description | Size |',
  '|-------|-------------|------|',
];

for (const s of skills) {
  const sizeLabel = s.large ? `${Math.round(s.size / 1024)}KB` : `${s.size}B`;
  lines.push(`| ${s.id} | ${s.description} | ${sizeLabel} |`);
}

lines.push('');
lines.push(`*Generated: ${new Date().toISOString().slice(0, 19)}*`);

writeFileSync(INDEX_PATH, lines.join('\n'));
console.error(`[SkillIndex] Generated index: ${skills.length} skills, ${skills.filter(s => s.large).length} large (>4KB)`);
