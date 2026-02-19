/**
 * Context injection for new sessions.
 *
 * When a new terminal session starts, gathers relevant memory context
 * (recent daily entries, path-scoped memory, search results) and injects
 * it into /workspace/CLAUDE.md so Claude Code reads it automatically.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { getDailyEntry, getDurableMemory, resolvePathId, PATHS } from './memory.js';
import { search, isSearchAvailable } from './memory-search.js';

const MARKER_START = '<!-- MEMORY_CONTEXT_START -->';
const MARKER_END = '<!-- MEMORY_CONTEXT_END -->';
const MAX_CONTEXT_CHARS = 5000;
// Daily logs can get long; only include the most recent portion so stale entries don't crowd out useful context.
const MAX_DAILY_CHARS = 1500;
const WORKSPACE_CLAUDE_MD = join(PATHS.WORKSPACE, 'CLAUDE.md');

/**
 * Build a memory context string from available sources.
 */
export function buildSessionContext(cwd: string): string {
  const parts: string[] = [];
  let totalLen = 0;

  const addPart = (label: string, content: string): boolean => {
    const trimmed = content.trim();
    if (!trimmed) return true;
    if (totalLen + trimmed.length + label.length + 10 > MAX_CONTEXT_CHARS) {
      // Truncate to fit
      const remaining = MAX_CONTEXT_CHARS - totalLen - label.length - 20;
      if (remaining > 100) {
        parts.push(`**${label}:**\n${trimmed.slice(0, remaining)}...`);
        totalLen = MAX_CONTEXT_CHARS;
      }
      return false;
    }
    parts.push(`**${label}:**\n${trimmed}`);
    totalLen += trimmed.length + label.length + 10;
    return true;
  };

  const today = new Date().toISOString().slice(0, 10);

  /** Truncate a daily log to the most recent MAX_DAILY_CHARS characters.
   *  Daily logs are append-only, so the end is always the most relevant. */
  const trimDaily = (content: string): string => {
    if (content.length <= MAX_DAILY_CHARS) return content;
    // Find a clean entry boundary to avoid cutting mid-entry
    const truncated = content.slice(-MAX_DAILY_CHARS);
    const firstNewline = truncated.indexOf('\n');
    return '...\n' + (firstNewline !== -1 ? truncated.slice(firstNewline + 1) : truncated);
  };

  // 1. Global durable memory (highest priority — curated long-term knowledge)
  const globalMemory = getDurableMemory();
  if (globalMemory.content) {
    addPart('Durable Memory', globalMemory.content);
  }

  // 2. Path-scoped durable memory and daily
  try {
    const pathId = resolvePathId(cwd);

    const pathMemory = getDurableMemory(pathId);
    if (pathMemory.content) {
      addPart('Project Memory', pathMemory.content);
    }

    // Path-scoped daily (recent portion only)
    const pathDaily = getDailyEntry(today, pathId);
    if (pathDaily.content) {
      addPart('Project Today', trimDaily(pathDaily.content));
    }
  } catch {
    // Path resolution can fail on first use, that's fine
  }

  // 3. Global daily — recent portion only (auto-summaries can be verbose/noisy)
  const todayEntry = getDailyEntry(today);
  if (todayEntry.content) {
    addPart(`Today (${today})`, trimDaily(todayEntry.content));
  } else {
    // Fallback: yesterday when today is empty
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const yesterdayEntry = getDailyEntry(yesterday);
    if (yesterdayEntry.content) {
      addPart(`Yesterday (${yesterday})`, trimDaily(yesterdayEntry.content));
    }
  }

  // 4. FTS search for project name (if search is available and budget remains)
  if (totalLen < MAX_CONTEXT_CHARS - 300 && isSearchAvailable()) {
    const projectName = cwd.split('/').pop() || '';
    if (projectName && projectName !== 'workspace') {
      try {
        const results = search({ query: projectName, limit: 3, scope: ['durable', 'decision'] });
        if (results.length > 0) {
          const snippets = results
            .map(r => r.snippet.replace(/<\/?mark>/g, ''))
            .join('\n');
          addPart('Related Memory', snippets);
        }
      } catch {
        // Search failure is non-fatal
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * Inject memory context into /workspace/CLAUDE.md.
 * Uses marker comments to replace only the memory section.
 */
export function injectContextIntoCLAUDEMd(cwd: string): void {
  if (!existsSync(WORKSPACE_CLAUDE_MD)) {
    console.log('[MemoryContext] No workspace CLAUDE.md found, skipping injection');
    return;
  }

  const context = buildSessionContext(cwd);
  if (!context) {
    // Remove existing context section if present
    removeContextSection();
    return;
  }

  const contextBlock = `\n## Recent Memory\n${MARKER_START}\n${context}\n${MARKER_END}\n`;

  let content = readFileSync(WORKSPACE_CLAUDE_MD, 'utf-8');

  // Check if markers already exist
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Find the ## Recent Memory header before the marker
    const headerPattern = /\n## Recent Memory\n/;
    const headerMatch = content.slice(0, startIdx).match(headerPattern);
    const replaceStart = headerMatch ? content.lastIndexOf('\n## Recent Memory\n', startIdx) : startIdx;
    content = content.slice(0, replaceStart) + contextBlock + content.slice(endIdx + MARKER_END.length);
  } else {
    // Append at the end
    content = content.trimEnd() + '\n' + contextBlock;
  }

  writeFileSync(WORKSPACE_CLAUDE_MD, content);
  console.log(`[MemoryContext] Injected ${context.length} chars of context into CLAUDE.md`);
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
    // Also remove ## Recent Memory header
    const headerIdx = content.lastIndexOf('\n## Recent Memory\n', startIdx);
    const removeFrom = headerIdx !== -1 ? headerIdx : startIdx;
    content = content.slice(0, removeFrom) + content.slice(endIdx + MARKER_END.length);
    writeFileSync(WORKSPACE_CLAUDE_MD, content.trimEnd() + '\n');
  }
}
