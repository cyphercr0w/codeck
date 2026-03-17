import { readdir, stat, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const CODECK_DIR = join(WORKSPACE, '.codeck');
const MEMORY_DIR = join(CODECK_DIR, 'memory');
const DAILY_DIR = join(MEMORY_DIR, 'daily');
const DECISIONS_DIR = join(MEMORY_DIR, 'decisions');
const PATHS_DIR = join(MEMORY_DIR, 'paths');
const DURABLE_PATH = join(MEMORY_DIR, 'MEMORY.md');
const SESSIONS_DIR = join(CODECK_DIR, 'sessions');

export interface MemoryStats {
  sessionsRemembered: number;
  totalMemoryKB: number;
  durableMemoryLines: number;
  dailyLogCount: number;
  decisionsCount: number;
  projectsTracked: number;
  lastActivityAt: number | null;
  totalSessionBytes: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
}

/** Count files in a directory matching an optional extension filter */
async function countFiles(dir: string, ext?: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  try {
    const entries = await readdir(dir);
    if (!ext) return entries.length;
    return entries.filter(e => e.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

/** Recursively compute total size of a directory in bytes */
async function dirSizeBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBytes(fullPath);
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath);
          total += s.size;
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* dir unreadable */ }
  return total;
}

/** Count lines in a file */
async function countLines(filePath: string): Promise<number> {
  if (!existsSync(filePath)) return 0;
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/** Find most recent mtime among daily log files */
async function lastDailyActivity(): Promise<number | null> {
  if (!existsSync(DAILY_DIR)) return null;
  try {
    const entries = await readdir(DAILY_DIR);
    const mdFiles = entries.filter(e => e.endsWith('.md'));
    if (mdFiles.length === 0) return null;

    let latest = 0;
    for (const f of mdFiles) {
      try {
        const s = await stat(join(DAILY_DIR, f));
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      } catch { /* skip */ }
    }
    return latest > 0 ? Math.floor(latest) : null;
  } catch {
    return null;
  }
}

/** Compute total size of session JSONL files in bytes */
async function sessionBytesTotal(): Promise<number> {
  if (!existsSync(SESSIONS_DIR)) return 0;
  let total = 0;
  try {
    const entries = await readdir(SESSIONS_DIR);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const s = await stat(join(SESSIONS_DIR, name));
        total += s.size;
      } catch { /* skip */ }
    }
  } catch { /* dir unreadable */ }
  return total;
}

// Sonnet pricing per million tokens (USD)
const SONNET_INPUT_PER_MTOK = 3;
const SONNET_OUTPUT_PER_MTOK = 15;
// Assume 50/50 input/output mix → blended rate
const BLENDED_PER_MTOK = (SONNET_INPUT_PER_MTOK + SONNET_OUTPUT_PER_MTOK) / 2;
// Rough conversion: 1 byte ≈ 0.25 tokens
const BYTES_TO_TOKENS = 0.25;

/** Count path memory directories (each represents a tracked project) */
async function countProjects(): Promise<number> {
  if (!existsSync(PATHS_DIR)) return 0;
  try {
    const entries = await readdir(PATHS_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const [
    sessionsRemembered,
    totalMemoryBytes,
    durableMemoryLines,
    dailyLogCount,
    decisionsCount,
    projectsTracked,
    lastActivityAt,
    totalSessionBytes,
  ] = await Promise.all([
    countFiles(SESSIONS_DIR, '.jsonl'),
    dirSizeBytes(MEMORY_DIR),
    countLines(DURABLE_PATH),
    countFiles(DAILY_DIR, '.md'),
    countFiles(DECISIONS_DIR, '.md'),
    countProjects(),
    lastDailyActivity(),
    sessionBytesTotal(),
  ]);

  const estimatedTokens = Math.round(totalSessionBytes * BYTES_TO_TOKENS);
  const estimatedCostUsd = parseFloat(((estimatedTokens / 1_000_000) * BLENDED_PER_MTOK).toFixed(2));

  return {
    sessionsRemembered,
    totalMemoryKB: Math.round(totalMemoryBytes / 1024),
    durableMemoryLines,
    dailyLogCount,
    decisionsCount,
    projectsTracked,
    lastActivityAt,
    totalSessionBytes,
    estimatedTokens,
    estimatedCostUsd,
  };
}
