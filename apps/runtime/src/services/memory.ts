import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { createHash, randomBytes } from 'crypto';
import { sanitizeSecrets } from './session-writer.js';

// ── Atomic write helper ──
// Writes to a temp file in the same directory, then renames atomically.
// Prevents corruption from crashes or disk-full mid-write.

export function atomicWriteFileSync(filePath: string, data: string, options?: { mode?: number }): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, data, options);
    renameSync(tmpPath, filePath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    throw e;
  }
}

// ── Canonical paths ──

const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const CODECK_DIR = join(WORKSPACE, '.codeck');

// Memory files (agent-accessible)
const MEMORY_DIR = join(CODECK_DIR, 'memory');
const DAILY_DIR = join(MEMORY_DIR, 'daily');
const DECISIONS_DIR = join(MEMORY_DIR, 'decisions');
const PATHS_DIR = join(MEMORY_DIR, 'paths');
const DURABLE_PATH = join(MEMORY_DIR, 'MEMORY.md');

// Sessions (outside memory dir — raw PTY event logs)
const SESSIONS_DIR = join(CODECK_DIR, 'sessions');

// Index (outside memory dir — derived/ephemeral)
const INDEX_DIR = join(CODECK_DIR, 'index');

// State (path map, flush state)
const STATE_DIR = join(CODECK_DIR, 'state');
const PATHS_MAP_FILE = join(STATE_DIR, 'paths.json');
const FLUSH_STATE_FILE = join(STATE_DIR, 'flush_state.json');

// ── File write lock (canary: detects re-entrant writes if code goes async) ──

const activeLocks = new Set<string>();
function withWriteLock<T>(filepath: string, fn: () => T): T {
  if (activeLocks.has(filepath)) {
    throw new Error(`[memory] Concurrent write to ${filepath} — serialize callers`);
  }
  activeLocks.add(filepath);
  try { return fn(); }
  finally { activeLocks.delete(filepath); }
}

// ── Path ID system ──

interface PathMapping {
  canonicalPath: string;
  pathId: string;
  name: string;
  createdAt: number;
  renames?: { from: string; at: number }[];
}

function loadPathsMap(): Record<string, PathMapping> {
  if (!existsSync(PATHS_MAP_FILE)) return {};
  try { return JSON.parse(readFileSync(PATHS_MAP_FILE, 'utf-8')); } catch { return {}; }
}

function savePathsMap(map: Record<string, PathMapping>): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteFileSync(PATHS_MAP_FILE, JSON.stringify(map, null, 2));
}

export function computePathId(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}

/** Sanitize a pathId from untrusted input. Valid pathIds are 12-char lowercase hex. */
export function sanitizePathId(raw: string): string | null {
  const clean = raw.replace(/[^a-f0-9]/g, '').slice(0, 12);
  return clean.length === 12 ? clean : null;
}

export function resolvePathId(canonicalPath: string): string {
  const absPath = resolve(canonicalPath);
  const map = loadPathsMap();
  const pathId = computePathId(absPath);

  if (!map[pathId]) {
    map[pathId] = {
      canonicalPath: absPath,
      pathId,
      name: absPath.split('/').pop() || absPath,
      createdAt: Date.now(),
    };
    savePathsMap(map);
    // Create path-scoped dirs
    const pathDir = join(PATHS_DIR, pathId);
    if (!existsSync(pathDir)) mkdirSync(pathDir, { recursive: true });
    const pathDailyDir = join(pathDir, 'daily');
    if (!existsSync(pathDailyDir)) mkdirSync(pathDailyDir, { recursive: true });
  } else if (map[pathId].canonicalPath !== absPath) {
    console.error(`[Memory] PathId collision: ${pathId} maps to both "${map[pathId].canonicalPath}" and "${absPath}"`);
    throw new Error(`PathId collision detected for ${pathId}: already maps to ${map[pathId].canonicalPath}`);
  }

  return pathId;
}

export function listPathScopes(): PathMapping[] {
  const map = loadPathsMap();
  return Object.values(map).sort((a, b) => b.createdAt - a.createdAt);
}

export function getPathMapping(pathId: string): PathMapping | null {
  const map = loadPathsMap();
  return map[pathId] || null;
}

// ── Directory setup ──

export function ensureDirectories(): void {
  for (const dir of [MEMORY_DIR, DAILY_DIR, DECISIONS_DIR, PATHS_DIR, SESSIONS_DIR, INDEX_DIR, STATE_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`[Memory] Created ${dir}`);
    }
  }

  // Migrate legacy files
  migrateLegacy();
}

function migrateLegacy(): void {
  // summary.md → MEMORY.md
  const summaryPath = join(MEMORY_DIR, 'summary.md');
  if (!existsSync(DURABLE_PATH) && existsSync(summaryPath)) {
    writeFileSync(DURABLE_PATH, readFileSync(summaryPath, 'utf-8'));
    console.log('[Memory] Migrated summary.md → MEMORY.md');
  }

  // journal/ → daily/
  const oldJournalDir = join(MEMORY_DIR, 'journal');
  if (existsSync(oldJournalDir)) {
    const files = readdirSync(oldJournalDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const dest = join(DAILY_DIR, f);
      if (!existsSync(dest)) {
        writeFileSync(dest, readFileSync(join(oldJournalDir, f), 'utf-8'));
      }
    }
    if (files.length > 0) console.log(`[Memory] Migrated ${files.length} journal files to daily/`);
  }

  // projects/*.md → paths/<pathId>/MEMORY.md
  const oldProjectsDir = join(MEMORY_DIR, 'projects');
  if (existsSync(oldProjectsDir)) {
    const files = readdirSync(oldProjectsDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const projectName = f.replace(/\.md$/, '');
      // Use workspace + project name as canonical path for migration
      const canonicalPath = join(WORKSPACE, projectName);
      const pathId = resolvePathId(canonicalPath);
      const destPath = join(PATHS_DIR, pathId, 'MEMORY.md');
      if (!existsSync(destPath)) {
        writeFileSync(destPath, readFileSync(join(oldProjectsDir, f), 'utf-8'));
      }
    }
    if (files.length > 0) console.log(`[Memory] Migrated ${files.length} project files to paths/`);
  }

  // Old sessions dir inside memory → new sessions dir
  const oldSessionsDir = join(MEMORY_DIR, 'sessions');
  if (existsSync(oldSessionsDir)) {
    const files = readdirSync(oldSessionsDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const dest = join(SESSIONS_DIR, f);
      if (!existsSync(dest)) {
        writeFileSync(dest, readFileSync(join(oldSessionsDir, f), 'utf-8'));
      }
    }
    if (files.length > 0) console.log(`[Memory] Migrated ${files.length} session files`);
  }
}

// ── Durable Memory (MEMORY.md) — global ──

export function getDurableMemory(pathId?: string): { exists: boolean; content: string | null } {
  const path = pathId ? join(PATHS_DIR, pathId, 'MEMORY.md') : DURABLE_PATH;
  if (!existsSync(path)) return { exists: false, content: null };
  return { exists: true, content: readFileSync(path, 'utf-8') };
}

export function writeDurableMemory(content: string, pathId?: string): void {
  const path = pathId ? join(PATHS_DIR, pathId, 'MEMORY.md') : DURABLE_PATH;
  withWriteLock(path, () => {
    const dir = pathId ? join(PATHS_DIR, pathId) : MEMORY_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, sanitizeSecrets(content));
  });
}

export function appendToDurableMemory(section: string, entry: string, pathId?: string): void {
  const path = pathId ? join(PATHS_DIR, pathId, 'MEMORY.md') : DURABLE_PATH;
  withWriteLock(path, () => {
    let content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const cleanEntry = sanitizeSecrets(entry);

    const sectionHeader = `## ${section}`;
    const idx = content.indexOf(sectionHeader);
    if (idx !== -1) {
      const nextSection = content.indexOf('\n## ', idx + sectionHeader.length);
      const insertAt = nextSection !== -1 ? nextSection : content.length;
      content = content.slice(0, insertAt).trimEnd() + '\n\n' + cleanEntry.trim() + '\n' + content.slice(insertAt);
    } else {
      content = content.trimEnd() + '\n\n' + sectionHeader + '\n\n' + cleanEntry.trim() + '\n';
    }

    const dir = pathId ? join(PATHS_DIR, pathId) : MEMORY_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, content);
  });
}

// ── Daily journal ──

function dailyPath(date?: string, pathId?: string): string {
  const d = date || new Date().toISOString().slice(0, 10);
  if (pathId) return join(PATHS_DIR, pathId, 'daily', `${d}.md`);
  return join(DAILY_DIR, `${d}.md`);
}

export function getDailyEntry(date?: string, pathId?: string): { exists: boolean; date: string; content: string | null } {
  const d = date || new Date().toISOString().slice(0, 10);
  const path = dailyPath(d, pathId);
  if (!existsSync(path)) return { exists: false, date: d, content: null };
  return { exists: true, date: d, content: readFileSync(path, 'utf-8') };
}

export function appendToDaily(entry: string, project?: string, tags?: string[], pathId?: string): { date: string } {
  const d = new Date().toISOString().slice(0, 10);
  const path = dailyPath(d, pathId);

  withWriteLock(path, () => {
    const dir = pathId ? join(PATHS_DIR, pathId, 'daily') : DAILY_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().slice(11, 19);
    let line = `### ${timestamp}`;
    if (project) line += ` [${project}]`;
    if (tags && tags.length > 0) line += ` ${tags.map(t => `#${t}`).join(' ')}`;
    line += '\n\n' + sanitizeSecrets(entry).trim() + '\n';

    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf-8');
      writeFileSync(path, existing.trimEnd() + '\n\n' + line);
    } else {
      writeFileSync(path, `# Daily — ${d}\n\n` + line);
    }
  });

  return { date: d };
}

export function listDailyEntries(pathId?: string): { date: string; size: number }[] {
  const dir = pathId ? join(PATHS_DIR, pathId, 'daily') : DAILY_DIR;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ date: f.replace('.md', ''), size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ── Decisions (ADR) — new naming: ADR-YYYYMMDD-<slug>.md ──

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

export function createDecision(
  title: string, context: string, decision: string, consequences: string,
  project?: string, pathId?: string,
): { filename: string } {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = slugify(title);
  const filename = `ADR-${date}-${slug}.md`;

  let content = `# ${title}\n\n`;
  content += `**Date**: ${new Date().toISOString().slice(0, 10)}\n`;
  if (project) content += `**Project**: ${project}\n`;
  if (pathId) content += `**Scope**: ${pathId}\n`;
  content += `**Status**: Accepted\n\n`;
  content += `## Context\n\n${context.trim()}\n\n`;
  content += `## Decision\n\n${decision.trim()}\n\n`;
  content += `## Consequences\n\n${consequences.trim()}\n`;

  const dir = pathId ? join(PATHS_DIR, pathId, 'decisions') : DECISIONS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), sanitizeSecrets(content));

  return { filename };
}

export function listDecisions(pathId?: string): { filename: string; title: string; date: string }[] {
  const dir = pathId ? join(PATHS_DIR, pathId, 'decisions') : DECISIONS_DIR;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(join(dir, f), 'utf-8');
      const titleMatch = content.match(/^# (.+)$/m);
      const dateMatch = content.match(/^\*\*Date\*\*:\s*(.+)$/m);
      return {
        filename: f,
        title: titleMatch ? titleMatch[1].trim() : f,
        date: dateMatch ? dateMatch[1].trim() : '',
      };
    })
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

export function getDecision(filename: string): { exists: boolean; content: string | null } {
  const safe = filename.replace(/[^a-zA-Z0-9_\-.]/g, '');
  const path = join(DECISIONS_DIR, safe);
  if (!existsSync(path)) return { exists: false, content: null };
  return { exists: true, content: readFileSync(path, 'utf-8') };
}

// ── Path-scoped memory (replaces "projects") ──

export function getPathMemory(pathId: string): { exists: boolean; content: string | null } {
  return getDurableMemory(pathId);
}

export function writePathMemory(pathId: string, content: string): void {
  writeDurableMemory(content, pathId);
}

// ── Promote ──

export interface PromoteRequest {
  content: string;
  sourceRef?: string;      // file+range OR session event IDs
  targetScope: 'global' | string; // 'global' or pathId
  target: 'durable' | 'adr';
  section?: string;        // for durable: which ## section to append under
  tags?: string[];
  // ADR-specific fields
  title?: string;
  context?: string;
  decision?: string;
  consequences?: string;
}

export function promote(req: PromoteRequest): { success: boolean; detail: string } {
  const ts = new Date().toISOString();
  const pathId = req.targetScope === 'global' ? undefined : req.targetScope;

  if (req.target === 'adr') {
    if (!req.title || !req.context || !req.decision || !req.consequences) {
      return { success: false, detail: 'ADR requires title, context, decision, consequences' };
    }
    const { filename } = createDecision(req.title, req.context, req.decision, req.consequences, undefined, pathId);
    return { success: true, detail: `Created ${filename}` };
  }

  // Durable promotion: append with source reference and timestamp
  let entry = req.content.trim();
  const meta: string[] = [];
  if (req.sourceRef) meta.push(`Source: ${req.sourceRef}`);
  if (req.tags && req.tags.length > 0) meta.push(`Tags: ${req.tags.join(', ')}`);
  meta.push(`Promoted: ${ts}`);
  entry += '\n\n<!-- ' + meta.join(' | ') + ' -->';

  if (req.section) {
    appendToDurableMemory(req.section, entry, pathId);
  } else {
    appendToDurableMemory('Promoted', entry, pathId);
  }

  return { success: true, detail: `Promoted to ${pathId ? `paths/${pathId}` : 'global'} MEMORY.md` };
}

// ── Flush ──

interface FlushState {
  [sessionOrScope: string]: {
    lastFlushAt: number;
    lastFlushBytes: number;
  };
}

function loadFlushState(): FlushState {
  if (!existsSync(FLUSH_STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(FLUSH_STATE_FILE, 'utf-8')); } catch { return {}; }
}

function saveFlushState(state: FlushState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteFileSync(FLUSH_STATE_FILE, JSON.stringify(state, null, 2));
}

const FLUSH_COOLDOWN_MS = 30_000; // 30s minimum between flushes per scope

export function flush(content: string, scope: string, project?: string, tags?: string[]): { success: boolean; date?: string; reason?: string; cooldownRemaining?: number } {
  const state = loadFlushState();
  const now = Date.now();

  // Rate limit: at most once per FLUSH_COOLDOWN_MS per scope
  if (state[scope] && (now - state[scope].lastFlushAt) < FLUSH_COOLDOWN_MS) {
    const remaining = FLUSH_COOLDOWN_MS - (now - state[scope].lastFlushAt);
    return { success: false, reason: 'Flush cooldown active', cooldownRemaining: remaining };
  }

  const pathId = scope !== 'global' ? scope : undefined;
  const allTags = tags ? [...tags, 'flush'] : ['flush'];
  const result = appendToDaily(`[FLUSH] ${content}`, project, allTags, pathId);

  // Update flush state
  state[scope] = { lastFlushAt: now, lastFlushBytes: content.length };
  saveFlushState(state);

  return { success: true, date: result.date };
}

export function getFlushState(): FlushState {
  return loadFlushState();
}

// ── Backward compat ──

export function getSummary(): { exists: boolean; content: string | null } {
  if (existsSync(DURABLE_PATH)) return { exists: true, content: readFileSync(DURABLE_PATH, 'utf-8') };
  const summaryPath = join(MEMORY_DIR, 'summary.md');
  if (existsSync(summaryPath)) return { exists: true, content: readFileSync(summaryPath, 'utf-8') };
  return { exists: false, content: null };
}

export function getDecisionsLegacy(): { exists: boolean; content: string | null } {
  const path = join(MEMORY_DIR, 'decisions.md');
  if (!existsSync(path)) return { exists: false, content: null };
  return { exists: true, content: readFileSync(path, 'utf-8') };
}

// Legacy project compat — delegates to path system
export function listProjects(): string[] {
  const map = loadPathsMap();
  return Object.values(map).map(m => m.name);
}

export function getProjectMemory(name: string): { exists: boolean; content: string | null } {
  const map = loadPathsMap();
  const entry = Object.values(map).find(m => m.name === name);
  if (!entry) return { exists: false, content: null };
  return getDurableMemory(entry.pathId);
}

// ── Context assembly ──

export function assembleContext(pathId?: string): string {
  const parts: string[] = [];

  const durable = getDurableMemory();
  if (durable.content) parts.push('# Durable Memory\n\n' + durable.content);

  const daily = getDailyEntry();
  if (daily.content) {
    parts.push(`# Today's Daily (${daily.date})\n\n` + daily.content);
  } else {
    // Fall back to yesterday if today is empty
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const prev = getDailyEntry(yesterday);
    if (prev.content) parts.push(`# Yesterday's Daily (${prev.date})\n\n` + prev.content);
  }

  if (pathId) {
    const scoped = getDurableMemory(pathId);
    if (scoped.content) parts.push(`# Path Memory (${pathId})\n\n` + scoped.content);
    const scopedDaily = getDailyEntry(undefined, pathId);
    if (scopedDaily.content) parts.push(`# Path Daily (${pathId}, ${scopedDaily.date})\n\n` + scopedDaily.content);
  }

  return parts.join('\n\n---\n\n');
}

// ── Status ──

export function getMemoryStatus(): Record<string, unknown> {
  const flushState = loadFlushState();
  const pathsMap = loadPathsMap();
  const dailyCount = existsSync(DAILY_DIR) ? readdirSync(DAILY_DIR).filter(f => f.endsWith('.md')).length : 0;
  const decisionsCount = existsSync(DECISIONS_DIR) ? readdirSync(DECISIONS_DIR).filter(f => f.endsWith('.md')).length : 0;
  const sessionsCount = existsSync(SESSIONS_DIR) ? readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')).length : 0;
  const pathScopes = Object.keys(pathsMap).length;

  return {
    durableExists: existsSync(DURABLE_PATH),
    dailyCount,
    decisionsCount,
    sessionsCount,
    pathScopes,
    lastFlush: Object.values(flushState).reduce((max, s) => Math.max(max, s.lastFlushAt || 0), 0) || null,
  };
}

// ── Memory stats (detailed) ──

export function getMemoryStats(): Record<string, unknown> {
  let totalSize = 0;
  let fileCount = 0;
  let oldestDaily: string | null = null;
  let newestDaily: string | null = null;

  // Scan daily dir
  if (existsSync(DAILY_DIR)) {
    const files = readdirSync(DAILY_DIR).filter(f => f.endsWith('.md')).sort();
    for (const f of files) {
      const s = statSync(join(DAILY_DIR, f));
      totalSize += s.size;
      fileCount++;
    }
    if (files.length > 0) {
      oldestDaily = files[0].replace('.md', '');
      newestDaily = files[files.length - 1].replace('.md', '');
    }
  }

  // Scan durable
  if (existsSync(DURABLE_PATH)) {
    totalSize += statSync(DURABLE_PATH).size;
    fileCount++;
  }

  // Scan decisions
  if (existsSync(DECISIONS_DIR)) {
    const files = readdirSync(DECISIONS_DIR).filter(f => f.endsWith('.md'));
    for (const f of files) {
      totalSize += statSync(join(DECISIONS_DIR, f)).size;
      fileCount++;
    }
  }

  // Scan paths
  if (existsSync(PATHS_DIR)) {
    const scan = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (entry.name.endsWith('.md')) {
          totalSize += statSync(full).size;
          fileCount++;
        }
      }
    };
    scan(PATHS_DIR);
  }

  // Sessions
  let sessionCount = 0;
  let sessionsTotalSize = 0;
  if (existsSync(SESSIONS_DIR)) {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
    sessionCount = files.length;
    for (const f of files) {
      sessionsTotalSize += statSync(join(SESSIONS_DIR, f)).size;
    }
  }

  return {
    totalSizeBytes: totalSize,
    totalSizeKB: Math.round(totalSize / 1024),
    fileCount,
    oldestDaily,
    newestDaily,
    sessionCount,
    sessionsTotalSizeKB: Math.round(sessionsTotalSize / 1024),
  };
}

// ── File listing for UI ──

export function listMemoryFiles(): { type: string; path: string; size: number; modified: number }[] {
  const files: { type: string; path: string; size: number; modified: number }[] = [];

  // Durable
  if (existsSync(DURABLE_PATH)) {
    const s = statSync(DURABLE_PATH);
    files.push({ type: 'durable', path: 'MEMORY.md', size: s.size, modified: s.mtimeMs });
  }

  // Daily
  if (existsSync(DAILY_DIR)) {
    for (const f of readdirSync(DAILY_DIR).filter(x => x.endsWith('.md'))) {
      const s = statSync(join(DAILY_DIR, f));
      files.push({ type: 'daily', path: `daily/${f}`, size: s.size, modified: s.mtimeMs });
    }
  }

  // Decisions
  if (existsSync(DECISIONS_DIR)) {
    for (const f of readdirSync(DECISIONS_DIR).filter(x => x.endsWith('.md'))) {
      const s = statSync(join(DECISIONS_DIR, f));
      files.push({ type: 'decision', path: `decisions/${f}`, size: s.size, modified: s.mtimeMs });
    }
  }

  // Path scopes
  if (existsSync(PATHS_DIR)) {
    for (const pid of readdirSync(PATHS_DIR)) {
      const pidDir = join(PATHS_DIR, pid);
      if (!statSync(pidDir).isDirectory()) continue;
      const memPath = join(pidDir, 'MEMORY.md');
      if (existsSync(memPath)) {
        const s = statSync(memPath);
        files.push({ type: 'path', path: `paths/${pid}/MEMORY.md`, size: s.size, modified: s.mtimeMs });
      }
      const dailyDir = join(pidDir, 'daily');
      if (existsSync(dailyDir)) {
        for (const f of readdirSync(dailyDir).filter(x => x.endsWith('.md'))) {
          const s = statSync(join(dailyDir, f));
          files.push({ type: 'path-daily', path: `paths/${pid}/daily/${f}`, size: s.size, modified: s.mtimeMs });
        }
      }
    }
  }

  // Sessions
  if (existsSync(SESSIONS_DIR)) {
    for (const f of readdirSync(SESSIONS_DIR).filter(x => x.endsWith('.jsonl'))) {
      const s = statSync(join(SESSIONS_DIR, f));
      files.push({ type: 'session', path: `sessions/${f}`, size: s.size, modified: s.mtimeMs });
    }
  }

  return files.sort((a, b) => b.modified - a.modified);
}

// ── Exported paths ──

export const PATHS = {
  WORKSPACE,
  CODECK_DIR,
  MEMORY_DIR,
  DAILY_DIR,
  DECISIONS_DIR,
  PATHS_DIR,
  SESSIONS_DIR,
  INDEX_DIR,
  STATE_DIR,
  DURABLE_PATH,
} as const;
