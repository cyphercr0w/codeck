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
const MAX_CONTEXT_CHARS = 30000;
// Daily logs can get long; only include the most recent portion so stale entries don't crowd out useful context.
const MAX_DAILY_CHARS = 6000;
const WORKSPACE_CLAUDE_MD = join(PATHS.WORKSPACE, 'CLAUDE.md');

export interface ContextInjectionStats {
  charsInjected: number;
  projectName: string;
  sources: string[];
}

/**
 * Build a memory context string from available sources.
 * Returns the context string and metadata about what was included.
 */
export function buildSessionContext(cwd: string): { context: string; stats: ContextInjectionStats } {
  const parts: string[] = [];
  const sources: string[] = [];
  let totalLen = 0;

  // Map labels to XML tag names for better compaction survival (92% vs 71% markdown)
  const tagMap: Record<string, string> = {
    'Project Memory': 'project-memory',
    'Project Today': 'project-today',
    'Durable Memory': 'durable-memory',
    'Related Memory': 'related-memory',
  };

  const addPart = (label: string, content: string, source?: string): boolean => {
    const trimmed = content.trim();
    if (!trimmed) return true;
    const tag = tagMap[label] || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const overhead = tag.length * 2 + 10; // <tag>...</tag> + newlines
    if (totalLen + trimmed.length + overhead > MAX_CONTEXT_CHARS) {
      const remaining = MAX_CONTEXT_CHARS - totalLen - overhead - 10;
      if (remaining > 100) {
        parts.push(`<${tag}>\n${trimmed.slice(0, remaining)}...\n</${tag}>`);
        totalLen = MAX_CONTEXT_CHARS;
        if (source && !sources.includes(source)) sources.push(source);
      }
      return false;
    }
    parts.push(`<${tag}>\n${trimmed}\n</${tag}>`);
    totalLen += trimmed.length + overhead;
    if (source && !sources.includes(source)) sources.push(source);
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

  // 1. Path-scoped memory (highest priority when in a project — most relevant context)
  try {
    const pathId = resolvePathId(cwd);

    const pathMemory = getDurableMemory(pathId);
    if (pathMemory.content) {
      addPart('Project Memory', pathMemory.content, 'path');
    }

    // Path-scoped daily (recent portion only)
    const pathDaily = getDailyEntry(today, pathId);
    if (pathDaily.content) {
      addPart('Project Today', trimDaily(pathDaily.content), 'path');
    }
  } catch {
    // Path resolution can fail on first use, that's fine
  }

  // 2. Global durable memory (curated long-term knowledge)
  const globalMemory = getDurableMemory();
  if (globalMemory.content) {
    addPart('Durable Memory', globalMemory.content, 'durable');
  }

  // 3. Global daily — recent portion only (auto-summaries can be verbose/noisy)
  const todayEntry = getDailyEntry(today);
  if (todayEntry.content) {
    tagMap[`Today (${today})`] = 'today-activity';
    addPart(`Today (${today})`, trimDaily(todayEntry.content), 'daily');
  } else {
    // Fallback: yesterday when today is empty
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const yesterdayEntry = getDailyEntry(yesterday);
    if (yesterdayEntry.content) {
      tagMap[`Yesterday (${yesterday})`] = 'yesterday-activity';
      addPart(`Yesterday (${yesterday})`, trimDaily(yesterdayEntry.content), 'daily');
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
          addPart('Related Memory', snippets, 'search');
        }
      } catch {
        // Search failure is non-fatal
      }
    }
  }

  const context = parts.join('\n\n');
  const projectName = cwd.split('/').pop() || 'workspace';
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
    // Remove existing context section if present
    removeContextSection();
    return null;
  }

  const contextBlock = `\n${MARKER_START}\n<recent-memory>\n${context}\n</recent-memory>\n${MARKER_END}\n`;

  let content = readFileSync(WORKSPACE_CLAUDE_MD, 'utf-8');

  // Check if markers already exist
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Clean up legacy ## Recent Memory header if present before the marker
    const headerIdx = content.lastIndexOf('\n## Recent Memory\n', startIdx);
    const replaceStart = headerIdx !== -1 ? headerIdx : startIdx;
    content = content.slice(0, replaceStart) + contextBlock + content.slice(endIdx + MARKER_END.length);
  } else {
    // Append at the end
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
    // Also remove legacy ## Recent Memory header if present
    const headerIdx = content.lastIndexOf('\n## Recent Memory\n', startIdx);
    const removeFrom = headerIdx !== -1 ? headerIdx : startIdx;
    content = content.slice(0, removeFrom) + content.slice(endIdx + MARKER_END.length);
    writeFileSync(WORKSPACE_CLAUDE_MD, content.trimEnd() + '\n');
  }
}
