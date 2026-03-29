#!/usr/bin/env node

/**
 * Consolidation Decay — Applies Ebbinghaus decay to WARM tier memory files.
 *
 * Formula: strength = importance * Math.exp(-0.16 * days_since_created) * (1 + recall_count * 0.2)
 *
 * Files in WARM tier with strength < 0.1 are moved to COLD tier after
 * generating a one-line summary.
 *
 * Usage: node /workspace/.codeck/scripts/consolidation-decay.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';

const MEMORY_DIR = '/workspace/.codeck/memory';
const ARCHIVE_DIR = join(MEMORY_DIR, 'archive');
const WARM_DIR = join(ARCHIVE_DIR, 'warm');
const COLD_DIR = join(ARCHIVE_DIR, 'cold');
const AUDIT_PATH = join(ARCHIVE_DIR, 'consolidation-audit.json');
const DECAY_STATE_PATH = join(ARCHIVE_DIR, 'decay-state.json');

// Ensure directories
for (const dir of [WARM_DIR, COLD_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Decay parameters ──
const DECAY_RATE = 0.16;       // Ebbinghaus forgetting curve lambda
const STRENGTH_THRESHOLD = 0.1; // Below this → move to COLD
const BASE_IMPORTANCE = 1.0;    // Default importance if not tagged

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

// ── Importance heuristic ──
// Score based on content markers

function estimateImportance(content) {
  let score = BASE_IMPORTANCE;

  // Decision records are more important
  if (content.includes('## Decision') || content.includes('ADR-')) score += 0.5;

  // Security-related content
  if (/security|vulnerability|auth|credential/i.test(content)) score += 0.3;

  // Architecture decisions
  if (/architecture|design|pattern|refactor/i.test(content)) score += 0.3;

  // Bug fixes (useful for future reference)
  if (/bug|fix|regression|broke/i.test(content)) score += 0.2;

  // Feature implementations
  if (/feature|implement|ship|deploy/i.test(content)) score += 0.1;

  // Routine / low value
  if (/debug output|temporary|exploration|experiment/i.test(content)) score -= 0.3;

  return Math.max(0.1, Math.min(2.0, score)); // Clamp [0.1, 2.0]
}

// ── Recall count heuristic ──
// Count how many times content was likely recalled (referenced in other files)

function estimateRecallCount(filename, content) {
  // Simple heuristic: check if the file's date appears in recent daily logs
  // More sophisticated implementations could track actual search/access logs
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return 0;

  // For now, return 0 — future versions can track actual recalls
  // via search query logs or access timestamps
  return 0;
}

// ── Extract date from file ──

function getFileAge(filename) {
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const fileDate = new Date(dateMatch[1]);
    const now = new Date();
    const diffMs = now.getTime() - fileDate.getTime();
    return Math.max(0, diffMs / (1000 * 60 * 60 * 24)); // days
  }

  // Fallback: use file stat mtime
  try {
    const stat = statSync(join(WARM_DIR, filename));
    const diffMs = Date.now() - stat.mtimeMs;
    return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
  } catch {
    return 30; // Default to 30 days old if we can't determine
  }
}

// ── Generate summary from content ──

function generateSummary(filename, content) {
  // Extract the first meaningful heading or first non-empty line
  const lines = content.split('\n').filter(l => l.trim());
  const heading = lines.find(l => l.startsWith('#'));
  const firstLine = lines[0] || filename;

  // Count key stats
  const bulletCount = (content.match(/^\s*[-*]\s+/gm) || []).length;
  const wordCount = content.split(/\s+/).length;

  const title = heading ? heading.replace(/^#+\s*/, '') : firstLine.slice(0, 80);
  return `${title} (${bulletCount} items, ${wordCount} words)`;
}

// ── Main decay process ──

function runDecay() {
  if (!existsSync(WARM_DIR)) {
    console.log('[Consolidation-Decay] No WARM tier directory, nothing to process');
    return { processed: 0, decayed: 0, retained: 0 };
  }

  const files = readdirSync(WARM_DIR).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('[Consolidation-Decay] No files in WARM tier');
    return { processed: 0, decayed: 0, retained: 0 };
  }

  const results = { processed: 0, decayed: 0, retained: 0, details: [] };

  for (const file of files) {
    const filePath = join(WARM_DIR, file);
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.warn(`[Consolidation-Decay] Failed to read ${file}: ${e.message}`);
      continue;
    }

    results.processed++;

    const daysSinceCreated = getFileAge(file);
    const importance = estimateImportance(content);
    const recallCount = estimateRecallCount(file, content);

    // Ebbinghaus decay formula
    const strength = importance * Math.exp(-DECAY_RATE * daysSinceCreated) * (1 + recallCount * 0.2);

    const detail = {
      file,
      daysSinceCreated: Math.round(daysSinceCreated),
      importance: Math.round(importance * 100) / 100,
      recallCount,
      strength: Math.round(strength * 1000) / 1000,
      action: strength < STRENGTH_THRESHOLD ? 'decay_to_cold' : 'retain',
    };

    if (strength < STRENGTH_THRESHOLD) {
      // Generate summary before archiving
      const summary = generateSummary(file, content);

      // Write summary to cold tier
      const summaryFile = file.replace('.md', '.summary.md');
      const summaryContent = `# Archived: ${file}\n\n` +
        `- **Original date**: ${file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || 'unknown'}\n` +
        `- **Archived**: ${new Date().toISOString().slice(0, 10)}\n` +
        `- **Decay strength**: ${detail.strength}\n` +
        `- **Summary**: ${summary}\n`;

      atomicWrite(join(COLD_DIR, summaryFile), summaryContent);

      // Move original to cold tier (non-destructive: copy then delete)
      try {
        copyFileSync(filePath, join(COLD_DIR, file));
        unlinkSync(filePath);
        results.decayed++;
        console.log(`[Consolidation-Decay] DECAY ${file} (strength=${detail.strength}) → COLD`);
      } catch (e) {
        console.warn(`[Consolidation-Decay] Failed to move ${file} to COLD: ${e.message}`);
      }
    } else {
      results.retained++;
      console.log(`[Consolidation-Decay] RETAIN ${file} (strength=${detail.strength})`);
    }

    results.details.push(detail);
  }

  // Save decay state
  const state = {
    lastDecayRun: Date.now(),
    lastDecayResult: {
      processed: results.processed,
      decayed: results.decayed,
      retained: results.retained,
    },
    details: results.details,
  };
  atomicWrite(DECAY_STATE_PATH, JSON.stringify(state, null, 2));

  return results;
}

// ── Main ──

try {
  const result = runDecay();
  console.log(`[Consolidation-Decay] Done: processed=${result.processed}, decayed=${result.decayed}, retained=${result.retained}`);
  process.exit(0);
} catch (e) {
  console.error(`[Consolidation-Decay] Fatal error: ${e.message}`);
  process.exit(1);
}
