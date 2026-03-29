#!/usr/bin/env node

/**
 * Generate Weekly Digest — Reads last 7 days of daily logs and produces
 * a human-readable summary with aggregate stats.
 *
 * No LLM needed — pure text analysis.
 *
 * Output: /workspace/.codeck/memory/digests/week-YYYY-WW.md
 *
 * Usage: node /workspace/.codeck/scripts/generate-weekly-digest.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

const MEMORY_DIR = '/workspace/.codeck/memory';
const DAILY_DIR = join(MEMORY_DIR, 'daily');
const WARM_DIR = join(MEMORY_DIR, 'archive', 'warm');
const DIGESTS_DIR = join(MEMORY_DIR, 'digests');

// Ensure digest directory exists
if (!existsSync(DIGESTS_DIR)) mkdirSync(DIGESTS_DIR, { recursive: true });

function atomicWrite(filePath, data) {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, filePath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

// ── Get ISO week number ──

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ── Pattern matchers for stats extraction ──

const PATTERNS = {
  filesChanged: [
    /(\d+)\s+files?\s+changed/gi,
    /(?:created|modified|updated|split|refactored|deleted)\s+\S+\.(?:ts|tsx|js|mjs|css|md|json)/gi,
    /\S+\.(?:ts|tsx|js|mjs|css|json)\s*[:→]/gi,
  ],
  decisions: [
    /(?:decided|decision|chose|picked|selected|switched to|migrated to)\b/gi,
    /ADR[-\s]?\d+/gi,
  ],
  bugsFixed: [
    /(?:fixed|fix|bugfix|resolved|patched)\b/gi,
    /bug\b/gi,
    /regression\b/gi,
  ],
  featuresAdded: [
    /(?:implemented|added|built|shipped|launched|created|new feature)\b/gi,
    /feat(?:ure)?:/gi,
  ],
  securityChanges: [
    /(?:security|auth|credential|encrypt|vulnerability|CVE|XSS|CSRF|injection)\b/gi,
  ],
  performance: [
    /(?:performance|optimize|cache|latency|throughput|faster|slower)\b/gi,
    /\d+ms\b/gi,
    /\d+KB\b/gi,
  ],
  refactors: [
    /(?:refactor|restructure|reorganize|cleanup|split|extract)\b/gi,
  ],
};

function countMatches(text, patterns) {
  const matches = new Set();
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      // Deduplicate by position
      matches.add(`${match.index}:${match[0]}`);
    }
  }
  return matches.size;
}

// ── Extract project names from daily logs ──

function extractProjects(content) {
  const projects = new Set();
  // Match [project] tags and path references
  const projectPatterns = [
    /\[([a-zA-Z0-9_-]+)\]/g,
    /\/workspace\/([a-zA-Z0-9_-]+)/g,
  ];
  for (const pattern of projectPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name && name.length > 1 && !['md', 'ts', 'js', 'json', 'css', 'mjs'].includes(name)) {
        projects.add(name);
      }
    }
  }
  return Array.from(projects);
}

// ── Extract key highlights (lines with ## or ### headings) ──

function extractHighlights(content, maxItems = 10) {
  const highlights = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Capture section headers (## or ###)
    if (trimmed.match(/^#{2,3}\s+/) && !trimmed.match(/^##\s*\d{4}/)) {
      const text = trimmed.replace(/^#+\s*/, '');
      if (text.length > 5 && !highlights.includes(text)) {
        highlights.push(text);
      }
    }
  }

  return highlights.slice(0, maxItems);
}

// ── Main ──

function generateDigest() {
  const now = new Date();
  const weekNum = getWeekNumber(now);
  const year = now.getFullYear();
  const weekStr = String(weekNum).padStart(2, '0');
  const digestFile = `week-${year}-${weekStr}.md`;
  const digestPath = join(DIGESTS_DIR, digestFile);

  // Collect last 7 days of daily logs (check both HOT and WARM dirs)
  const dailyEntries = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(now.getTime() - i * 86400000);
    const dateStr = date.toISOString().slice(0, 10);

    // Check HOT tier first, then WARM
    for (const dir of [DAILY_DIR, WARM_DIR]) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(f => f.startsWith(dateStr) && f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf-8');
          dailyEntries.push({ date: dateStr, file, content });
        } catch { /* skip unreadable */ }
      }
    }
  }

  if (dailyEntries.length === 0) {
    console.log('[Weekly-Digest] No daily logs found for the past 7 days');
    return { generated: false, reason: 'no_daily_logs' };
  }

  // Combine all content for analysis
  const allContent = dailyEntries.map(e => e.content).join('\n');
  const totalWords = allContent.split(/\s+/).filter(Boolean).length;
  const totalLines = allContent.split('\n').length;

  // Extract stats
  const stats = {
    filesChanged: countMatches(allContent, PATTERNS.filesChanged),
    decisions: countMatches(allContent, PATTERNS.decisions),
    bugsFixed: countMatches(allContent, PATTERNS.bugsFixed),
    featuresAdded: countMatches(allContent, PATTERNS.featuresAdded),
    securityChanges: countMatches(allContent, PATTERNS.securityChanges),
    performance: countMatches(allContent, PATTERNS.performance),
    refactors: countMatches(allContent, PATTERNS.refactors),
  };

  const projects = extractProjects(allContent);
  const highlights = extractHighlights(allContent, 15);

  // Date range
  const dates = dailyEntries.map(e => e.date).sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  // Generate digest
  const digest = `# Weekly Digest — Week ${weekNum}, ${year}

**Period**: ${startDate} to ${endDate}
**Daily logs processed**: ${dailyEntries.length}
**Total content**: ${totalWords} words across ${totalLines} lines

## Summary Stats

| Metric | Count |
|--------|-------|
| Files changed (approx) | ${stats.filesChanged} |
| Features added | ${stats.featuresAdded} |
| Bugs fixed | ${stats.bugsFixed} |
| Decisions made | ${stats.decisions} |
| Security changes | ${stats.securityChanges} |
| Performance work | ${stats.performance} |
| Refactors | ${stats.refactors} |

## Projects Touched

${projects.length > 0 ? projects.map(p => `- ${p}`).join('\n') : '- (none detected)'}

## Key Highlights

${highlights.length > 0 ? highlights.map(h => `- ${h}`).join('\n') : '- (no section headers found)'}

## Daily Breakdown

${dailyEntries
  .sort((a, b) => a.date.localeCompare(b.date))
  .map(e => {
    const words = e.content.split(/\s+/).filter(Boolean).length;
    const heading = e.content.split('\n').find(l => l.startsWith('#'))?.replace(/^#+\s*/, '') || e.file;
    return `- **${e.date}**: ${heading} (${words} words)`;
  })
  .join('\n')}

---
_Generated by generate-weekly-digest.mjs at ${now.toISOString()}_
`;

  atomicWrite(digestPath, digest);
  console.log(`[Weekly-Digest] Generated ${digestFile}`);

  return {
    generated: true,
    file: digestFile,
    path: digestPath,
    stats,
    daysProcessed: dailyEntries.length,
    projects,
  };
}

try {
  const result = generateDigest();
  console.log(`[Weekly-Digest] Done:`, JSON.stringify(result, null, 2));
  process.exit(0);
} catch (e) {
  console.error(`[Weekly-Digest] Fatal error: ${e.message}`);
  process.exit(1);
}
