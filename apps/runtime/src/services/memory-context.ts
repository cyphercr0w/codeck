/**
 * Context injection for new sessions.
 *
 * When a new terminal session starts, gathers relevant memory context
 * (recent daily entries, path-scoped memory, search results) and injects
 * it into /workspace/CLAUDE.md so Claude Code reads it automatically.
 *
 * Uses HOT/WARM/COLD tiering to stay within token budgets:
 *   HOT  — always injected in full (durable memory, preferences, path memory)
 *   WARM — injected truncated (daily logs, recent activity)
 *   COLD — not injected, only searchable via FTS5 (old logs, decisions)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { getDailyEntry, getDurableMemory, resolvePathId, PATHS } from './memory.js';
import { search, isSearchAvailable } from './memory-search.js';

const MARKER_START = '<!-- MEMORY_CONTEXT_START -->';
const MARKER_END = '<!-- MEMORY_CONTEXT_END -->';
const WORKSPACE_CLAUDE_MD = join(PATHS.WORKSPACE, 'CLAUDE.md');

// ── Token budgets (chars, ~4 chars per token) ─────────────────────
// Research: performance degrades 20-50% from 10K to 100K injected tokens.
// Total budget ~5K tokens (~20K chars) keeps injection lean.
const HOT_BUDGET  = 12000; // ~3K tokens — durable memory, path memory, preferences
const WARM_BUDGET =  6000; // ~1.5K tokens — today's daily log (truncated)
const COLD_BUDGET =  2000; // ~500 tokens — related search results (snippets only)
const TOTAL_BUDGET = HOT_BUDGET + WARM_BUDGET + COLD_BUDGET; // ~5K tokens

// ── XML tag mapping ──────────────────────────────────────────────
const TAG_MAP: Record<string, string> = {
  'Project Memory': 'project-memory',
  'Project Today': 'project-today',
  'Durable Memory': 'durable-memory',
  'User Preferences': 'user-preferences',
  'Related Memory': 'related-memory',
};

export interface ContextInjectionStats {
  charsInjected: number;
  projectName: string;
  sources: string[];
}

/**
 * Build a memory context string from available sources using tiered budgets.
 */
export function buildSessionContext(cwd: string): { context: string; stats: ContextInjectionStats } {
  const parts: string[] = [];
  const sources: string[] = [];

  let hotUsed = 0;
  let warmUsed = 0;
  let coldUsed = 0;

  /** Add content within a specific tier budget. Returns chars actually added. */
  const addPart = (
    label: string,
    content: string,
    tier: 'hot' | 'warm' | 'cold',
    source?: string,
  ): number => {
    const trimmed = content.trim();
    if (!trimmed) return 0;

    const tag = TAG_MAP[label] || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const overhead = tag.length * 2 + 10;

    // Determine remaining budget for this tier
    const budgetMap = { hot: HOT_BUDGET - hotUsed, warm: WARM_BUDGET - warmUsed, cold: COLD_BUDGET - coldUsed };
    const remaining = budgetMap[tier] - overhead;

    if (remaining <= 100) return 0; // not enough space

    const text = trimmed.length <= remaining
      ? trimmed
      : trimmed.slice(0, remaining) + '...';

    parts.push(`<${tag}>\n${text}\n</${tag}>`);
    const used = text.length + overhead;

    if (tier === 'hot') hotUsed += used;
    else if (tier === 'warm') warmUsed += used;
    else coldUsed += used;

    if (source && !sources.includes(source)) sources.push(source);
    return used;
  };

  const today = new Date().toISOString().slice(0, 10);

  /** Truncate a daily log to the most recent N characters.
   *  Daily logs are append-only, so the end is always the most relevant. */
  const trimDaily = (content: string, maxChars: number): string => {
    if (content.length <= maxChars) return content;
    const truncated = content.slice(-maxChars);
    const firstNewline = truncated.indexOf('\n');
    return '...\n' + (firstNewline !== -1 ? truncated.slice(firstNewline + 1) : truncated);
  };

  // Resolve path ID once for both HOT and WARM tiers
  let pathId: string | null = null;
  try {
    pathId = resolvePathId(cwd);
  } catch { /* path resolution can fail on first use */ }

  // ── HOT tier: always injected in full ──────────────────────────

  // 1. Path-scoped memory (highest priority when in a project)
  if (pathId) {
    const pathMemory = getDurableMemory(pathId);
    if (pathMemory.content) {
      addPart('Project Memory', pathMemory.content, 'hot', 'path');
    }
  }

  // 2. Global durable memory (curated long-term knowledge)
  const globalMemory = getDurableMemory();
  if (globalMemory.content) {
    addPart('Durable Memory', globalMemory.content, 'hot', 'durable');
  }

  // ── WARM tier: injected truncated ─────────────────────────────

  // 3. Path-scoped daily (recent portion)
  if (pathId) {
    const pathDaily = getDailyEntry(today, pathId);
    if (pathDaily.content) {
      addPart('Project Today', trimDaily(pathDaily.content, WARM_BUDGET / 2), 'warm', 'path');
    }
  }

  // 4. Global daily — recent portion only
  const todayEntry = getDailyEntry(today);
  if (todayEntry.content) {
    TAG_MAP[`Today (${today})`] = 'today-activity';
    addPart(`Today (${today})`, trimDaily(todayEntry.content, WARM_BUDGET / 2), 'warm', 'daily');
  } else {
    // Fallback: yesterday when today is empty
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const yesterdayEntry = getDailyEntry(yesterday);
    if (yesterdayEntry.content) {
      TAG_MAP[`Yesterday (${yesterday})`] = 'yesterday-activity';
      addPart(`Yesterday (${yesterday})`, trimDaily(yesterdayEntry.content, WARM_BUDGET / 2), 'warm', 'daily');
    }
  }

  // ── COLD tier: snippets only, not full content ────────────────

  // 5. FTS search for project name (snippets from durable/decision scopes)
  if (coldUsed < COLD_BUDGET - 300 && isSearchAvailable()) {
    const projectName = cwd.split('/').pop() || '';
    if (projectName && projectName !== 'workspace') {
      try {
        const results = search({ query: projectName, limit: 3, scope: ['durable', 'decision'] });
        if (results.length > 0) {
          const snippets = results
            .map(r => r.snippet.replace(/<\/?mark>/g, ''))
            .join('\n');
          addPart('Related Memory', snippets, 'cold', 'search');
        }
      } catch {
        // Search failure is non-fatal
      }
    }
  }

  const context = parts.join('\n\n');
  const projectName = cwd.split('/').pop() || 'workspace';
  const totalUsed = hotUsed + warmUsed + coldUsed;
  console.log(`[MemoryContext] Budget: HOT ${hotUsed}/${HOT_BUDGET}, WARM ${warmUsed}/${WARM_BUDGET}, COLD ${coldUsed}/${COLD_BUDGET}, total ${totalUsed}/${TOTAL_BUDGET}`);

  return {
    context,
    stats: { charsInjected: context.length, projectName, sources },
  };
}

/**
 * Inject memory context into /workspace/CLAUDE.md.
 * Uses marker comments to replace only the memory section.
 */
export function injectContextIntoCLAUDEMd(cwd: string): ContextInjectionStats | null {
  if (!existsSync(WORKSPACE_CLAUDE_MD)) {
    console.log('[MemoryContext] No workspace CLAUDE.md found, skipping injection');
    return null;
  }

  const { context, stats } = buildSessionContext(cwd);
  if (!context) {
    removeContextSection();
    return null;
  }

  const contextBlock = `\n${MARKER_START}\n<recent-memory>\n${context}\n</recent-memory>\n${MARKER_END}\n`;

  let content = readFileSync(WORKSPACE_CLAUDE_MD, 'utf-8');

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const headerIdx = content.lastIndexOf('\n## Recent Memory\n', startIdx);
    const replaceStart = headerIdx !== -1 ? headerIdx : startIdx;
    content = content.slice(0, replaceStart) + contextBlock + content.slice(endIdx + MARKER_END.length);
  } else {
    content = content.trimEnd() + '\n' + contextBlock;
  }

  writeFileSync(WORKSPACE_CLAUDE_MD, content);
  console.log(`[MemoryContext] Injected ${stats.charsInjected} chars of context into CLAUDE.md (sources: ${stats.sources.join(', ')})`);
  return stats;
}

/**
 * Remove the memory context section from CLAUDE.md.
 */
function removeContextSection(): void {
  if (!existsSync(WORKSPACE_CLAUDE_MD)) return;

  let content = readFileSync(WORKSPACE_CLAUDE_MD, 'utf-8');
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const headerIdx = content.lastIndexOf('\n## Recent Memory\n', startIdx);
    const removeFrom = headerIdx !== -1 ? headerIdx : startIdx;
    content = content.slice(0, removeFrom) + content.slice(endIdx + MARKER_END.length);
    writeFileSync(WORKSPACE_CLAUDE_MD, content.trimEnd() + '\n');
  }
}
