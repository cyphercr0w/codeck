#!/usr/bin/env node

/**
 * Consolidation Apply — Reads pending-consolidation.md (output of memory-consolidation.mjs)
 * and applies the suggestions: ADD new facts, UPDATE existing ones, REMOVE (archive) outdated ones.
 *
 * Non-destructive: archived entries are moved, never deleted.
 * Writes audit trail to /workspace/.codeck/memory/archive/consolidation-audit.json
 *
 * Usage: node /workspace/.codeck/scripts/consolidation-apply.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';

const MEMORY_DIR = '/workspace/.codeck/memory';
const PENDING_PATH = join(MEMORY_DIR, 'pending-consolidation.md');
const DURABLE_PATH = join(MEMORY_DIR, 'MEMORY.md');
const DAILY_DIR = join(MEMORY_DIR, 'daily');
const ARCHIVE_DIR = join(MEMORY_DIR, 'archive');
const WARM_DIR = join(ARCHIVE_DIR, 'warm');
const COLD_DIR = join(ARCHIVE_DIR, 'cold');
const AUDIT_PATH = join(ARCHIVE_DIR, 'consolidation-audit.json');
const STATE_DIR = '/workspace/.codeck/state';
const CONSOLIDATION_STATE_PATH = join(STATE_DIR, 'consolidation-state.json');

// Ensure directories exist
for (const dir of [ARCHIVE_DIR, WARM_DIR, COLD_DIR, STATE_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Load audit log ──

function loadAudit() {
  if (!existsSync(AUDIT_PATH)) return { runs: [] };
  try {
    return JSON.parse(readFileSync(AUDIT_PATH, 'utf-8'));
  } catch {
    return { runs: [] };
  }
}

function saveAudit(audit) {
  // Keep last 100 runs to prevent unbounded growth
  if (audit.runs.length > 100) {
    audit.runs = audit.runs.slice(-100);
  }
  atomicWrite(AUDIT_PATH, JSON.stringify(audit, null, 2));
}

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

// ── Parse pending consolidation ──

function parsePending(content) {
  const suggestions = { adds: [], updates: [], removes: [] };

  // Split by section headers
  const sections = content.split(/^###\s+/m);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const header = lines[0]?.toLowerCase() || '';

    // Extract bullet points
    const bullets = lines.slice(1)
      .filter(l => l.match(/^\s*[-*]\s+/))
      .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean);

    if (header.includes('adding') || header.includes('add')) {
      suggestions.adds.push(...bullets);
    } else if (header.includes('updating') || header.includes('update')) {
      suggestions.updates.push(...bullets);
    } else if (header.includes('removing') || header.includes('remove')) {
      suggestions.removes.push(...bullets);
    }
  }

  return suggestions;
}

// ── Dedup check ──

function isDuplicate(newFact, existingContent) {
  // Normalize both strings for comparison
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const normalizedFact = normalize(newFact);
  const normalizedContent = normalize(existingContent);

  // Exact substring match
  if (normalizedContent.includes(normalizedFact)) return true;

  // Token overlap (Jaccard similarity > 0.7)
  const factTokens = new Set(normalizedFact.split(' ').filter(t => t.length > 2));
  const contentTokens = new Set(normalizedContent.split(' ').filter(t => t.length > 2));
  if (factTokens.size === 0) return true; // empty fact is duplicate by definition

  let overlap = 0;
  for (const token of factTokens) {
    if (contentTokens.has(token)) overlap++;
  }
  const similarity = overlap / factTokens.size;
  return similarity > 0.7;
}

// ── Apply suggestions ──

function applyConsolidation() {
  if (!existsSync(PENDING_PATH)) {
    console.log('[Consolidation-Apply] No pending-consolidation.md found, nothing to apply');
    return { applied: false, reason: 'no_pending_file' };
  }

  const pendingContent = readFileSync(PENDING_PATH, 'utf-8').trim();
  if (!pendingContent || pendingContent.includes('No changes needed')) {
    console.log('[Consolidation-Apply] No changes needed');
    // Clean up the pending file
    unlinkSync(PENDING_PATH);
    return { applied: false, reason: 'no_changes' };
  }

  const suggestions = parsePending(pendingContent);
  const durableContent = existsSync(DURABLE_PATH) ? readFileSync(DURABLE_PATH, 'utf-8') : '';

  const actions = [];
  let updatedDurable = durableContent;

  // Process ADDs — append to durable memory if not duplicate
  for (const fact of suggestions.adds) {
    if (isDuplicate(fact, durableContent)) {
      actions.push({ type: 'skip_duplicate', fact: fact.slice(0, 100) });
      console.log(`[Consolidation-Apply] SKIP (duplicate): ${fact.slice(0, 80)}...`);
      continue;
    }

    // Append to the "## Consolidated" section (create if missing)
    const consolidatedHeader = '## Consolidated';
    if (!updatedDurable.includes(consolidatedHeader)) {
      updatedDurable += `\n\n${consolidatedHeader}\n`;
    }
    updatedDurable += `- ${fact}\n`;
    actions.push({ type: 'add', fact: fact.slice(0, 100) });
    console.log(`[Consolidation-Apply] ADD: ${fact.slice(0, 80)}...`);
  }

  // Process UPDATEs — find matching section and append note
  for (const update of suggestions.updates) {
    // Extract the target (text before ':' or first sentence)
    const colonIdx = update.indexOf(':');
    const target = colonIdx > 0 ? update.slice(0, colonIdx).trim() : update.slice(0, 50);
    const detail = colonIdx > 0 ? update.slice(colonIdx + 1).trim() : update;

    // Find if target is mentioned in durable memory
    const targetLower = target.toLowerCase();
    if (durableContent.toLowerCase().includes(targetLower)) {
      // Already referenced — append detail as sub-bullet if not duplicate
      if (!isDuplicate(detail, durableContent)) {
        const consolidatedHeader = '## Consolidated Updates';
        if (!updatedDurable.includes(consolidatedHeader)) {
          updatedDurable += `\n\n${consolidatedHeader}\n`;
        }
        updatedDurable += `- **${target}**: ${detail}\n`;
        actions.push({ type: 'update', target: target.slice(0, 60), detail: detail.slice(0, 100) });
        console.log(`[Consolidation-Apply] UPDATE: ${target.slice(0, 60)}`);
      } else {
        actions.push({ type: 'skip_duplicate_update', target: target.slice(0, 60) });
      }
    } else {
      // Target not found — treat as ADD
      if (!isDuplicate(update, durableContent)) {
        const consolidatedHeader = '## Consolidated';
        if (!updatedDurable.includes(consolidatedHeader)) {
          updatedDurable += `\n\n${consolidatedHeader}\n`;
        }
        updatedDurable += `- ${update}\n`;
        actions.push({ type: 'add_from_update', fact: update.slice(0, 100) });
      }
    }
  }

  // Process REMOVEs — mark as archived (don't actually remove from MEMORY.md,
  // just record in audit and add strikethrough comment)
  for (const removal of suggestions.removes) {
    actions.push({ type: 'archive_suggestion', fact: removal.slice(0, 100) });
    console.log(`[Consolidation-Apply] ARCHIVE SUGGESTION: ${removal.slice(0, 80)}...`);
    // We don't auto-remove from MEMORY.md — that requires human review.
    // Instead, mark it in a separate section.
    const archiveHeader = '## Pending Removal (review needed)';
    if (!updatedDurable.includes(archiveHeader)) {
      updatedDurable += `\n\n${archiveHeader}\n`;
    }
    updatedDurable += `- ~~${removal}~~\n`;
  }

  // Write updated durable memory
  if (updatedDurable !== durableContent) {
    atomicWrite(DURABLE_PATH, updatedDurable);
    console.log('[Consolidation-Apply] Updated MEMORY.md');
  }

  // Archive daily logs older than 7 days → WARM tier
  const archiveCount = archiveDailyLogs(7);

  // Write audit entry
  const audit = loadAudit();
  audit.runs.push({
    timestamp: new Date().toISOString(),
    pendingSize: pendingContent.length,
    suggestions: {
      adds: suggestions.adds.length,
      updates: suggestions.updates.length,
      removes: suggestions.removes.length,
    },
    actions,
    archivedDailyLogs: archiveCount,
  });
  saveAudit(audit);

  // Remove pending file after successful processing
  unlinkSync(PENDING_PATH);
  console.log('[Consolidation-Apply] Removed pending-consolidation.md');

  // Update consolidation state
  const state = {
    lastApplyRun: Date.now(),
    lastApplyResult: {
      adds: actions.filter(a => a.type === 'add' || a.type === 'add_from_update').length,
      updates: actions.filter(a => a.type === 'update').length,
      skips: actions.filter(a => a.type.startsWith('skip')).length,
      archiveSuggestions: actions.filter(a => a.type === 'archive_suggestion').length,
      archivedDailyLogs: archiveCount,
    },
  };
  atomicWrite(CONSOLIDATION_STATE_PATH, JSON.stringify(state, null, 2));

  return { applied: true, ...state.lastApplyResult };
}

// ── Archive daily logs from HOT (daily/) → WARM (archive/warm/) ──

function archiveDailyLogs(daysOld) {
  if (!existsSync(DAILY_DIR)) return 0;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  const files = readdirSync(DAILY_DIR).filter(f => f.endsWith('.md')).sort();
  let archived = 0;

  for (const file of files) {
    // Extract date from filename (YYYY-MM-DD.md or YYYY-MM-DD-suffix.md)
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const fileDate = dateMatch[1];
    if (fileDate >= cutoffStr) continue; // Still in HOT tier

    const src = join(DAILY_DIR, file);
    const dst = join(WARM_DIR, file);

    // Non-destructive: copy then delete
    try {
      copyFileSync(src, dst);
      unlinkSync(src);
      archived++;
      console.log(`[Consolidation-Apply] Archived daily/${file} → archive/warm/`);
    } catch (e) {
      console.warn(`[Consolidation-Apply] Failed to archive ${file}: ${e.message}`);
    }
  }

  return archived;
}

// ── Main ──

try {
  const result = applyConsolidation();
  console.log(`[Consolidation-Apply] Done:`, JSON.stringify(result));
  process.exit(0);
} catch (e) {
  console.error(`[Consolidation-Apply] Fatal error: ${e.message}`);
  process.exit(1);
}
