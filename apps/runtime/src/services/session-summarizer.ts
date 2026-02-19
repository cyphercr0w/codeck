/**
 * Post-session auto-summarization.
 *
 * When a session closes, parses the JSONL transcript and generates a
 * template-based summary that gets appended to the daily memory log.
 * No LLM required — pure parsing + heuristics.
 */

import { readFile, stat, unlink, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { appendToDaily, resolvePathId, PATHS } from './memory.js';

const MIN_SESSION_DURATION_MS = 30_000; // Skip sessions shorter than 30s
const MAX_USER_INPUTS_IN_SUMMARY = 8;
const MAX_FILE_PATHS_IN_SUMMARY = 15;
const MAX_INPUT_LENGTH = 120;

export interface TranscriptDigest {
  sessionId: string;
  cwd: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  userInputs: string[];
  filePaths: string[];
  errorCount: number;
  compactionCount: number;
  lineCount: number;
}

/**
 * Parse a JSONL transcript into a structured digest.
 * Pure function — no side effects.
 */
export function parseTranscriptForSummary(lines: string[], sessionId: string): TranscriptDigest {
  let cwd = '';
  let startTs = 0;
  let endTs = 0;
  const userInputs: string[] = [];
  const filePathsSet = new Set<string>();
  let errorCount = 0;
  let compactionCount = 0;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = obj.ts as number || 0;
    const role = obj.role as string;
    const data = obj.data as string || '';
    const event = obj.event as string || '';

    if (role === 'system') {
      if (event === 'start') {
        startTs = ts;
        cwd = (obj.cwd as string) || '';
      } else if (event === 'end') {
        endTs = ts;
      } else if (event === 'compaction_detected') {
        compactionCount++;
      }
    } else if (role === 'input') {
      // Collect user inputs (commands/prompts)
      const trimmed = data.trim();
      if (trimmed && trimmed.length > 1) {
        userInputs.push(trimmed);
      }
    } else if (role === 'output') {
      // Strip ANSI escape sequences and carriage returns before scanning
      const clean = data
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // ANSI CSI sequences
        .replace(/\x1b\][^\x07]*\x07/g, '')     // OSC sequences
        .replace(/\x1b./g, '')                   // Other escapes
        .replace(/\r/g, ' ');                    // CR → space

      // Scan for file paths — match both /workspace/ (Docker) and real host paths
      const pathRegex = /(?:\/workspace\/|\/home\/[^/]+\/workspace\/)([^\s'"`,)}\]>&|;=({\[!?]+)/g;
      let m: RegExpExecArray | null;
      while ((m = pathRegex.exec(clean)) !== null) {
        const raw = m[0].replace(/[.:;,!?]+$/, ''); // strip trailing punctuation
        if (raw.length < 200) filePathsSet.add(raw);
      }

      // Count error-like patterns
      const errorPatterns = /\b(error|Error|ERROR|FAIL|fail|panic|exception|Exception)\b/g;
      const matches = clean.match(errorPatterns);
      if (matches) errorCount += matches.length;
    }
  }

  // If no end event, use last timestamp
  if (!endTs && lines.length > 0) {
    try {
      const lastObj = JSON.parse(lines[lines.length - 1]);
      endTs = (lastObj.ts as number) || startTs;
    } catch { /* use startTs */ }
  }

  return {
    sessionId,
    cwd,
    startTs,
    endTs,
    durationMs: endTs - startTs,
    userInputs,
    filePaths: Array.from(filePathsSet),
    errorCount,
    compactionCount,
    lineCount: lines.length,
  };
}

/**
 * Build a markdown summary from a transcript digest.
 */
function buildSummary(digest: TranscriptDigest): string {
  const parts: string[] = [];

  // Duration
  const durationMin = Math.round(digest.durationMs / 60_000);
  const durationStr = durationMin < 1 ? '<1 min' : `${durationMin} min`;

  // Project name from cwd
  const project = digest.cwd.split('/').pop() || digest.cwd;

  parts.push(`Worked in \`${digest.cwd}\` for ${durationStr}.`);

  // Files touched
  if (digest.filePaths.length > 0) {
    const shown = digest.filePaths.slice(0, MAX_FILE_PATHS_IN_SUMMARY);
    const relative = shown.map(p =>
      p.replace(digest.cwd + '/', '')
       .replace(/^\/home\/[^/]+\/workspace\//, '')
       .replace(/^\/workspace\//, '')
    );
    // Deduplicate and filter out noise (blank, too short, still looks like a command)
    const clean = [...new Set(relative)].filter(p => p.length > 1 && !/^[&|;]/.test(p));
    if (clean.length > 0) {
      parts.push(`Files: ${clean.map(f => '`' + f + '`').join(', ')}${digest.filePaths.length > MAX_FILE_PATHS_IN_SUMMARY ? ` (+${digest.filePaths.length - MAX_FILE_PATHS_IN_SUMMARY} more)` : ''}`);
    }
  }

  // User inputs summary
  if (digest.userInputs.length > 0) {
    const shown = digest.userInputs.slice(0, MAX_USER_INPUTS_IN_SUMMARY);
    const truncated = shown.map(input => {
      const clean = input.replace(/\r?\n/g, ' ').trim();
      return clean.length > MAX_INPUT_LENGTH ? clean.slice(0, MAX_INPUT_LENGTH) + '...' : clean;
    });
    parts.push(`Activity: ${truncated.join(' | ')}`);
  }

  // Stats
  const stats: string[] = [];
  if (digest.errorCount > 0) stats.push(`${digest.errorCount} errors`);
  if (digest.compactionCount > 0) stats.push(`${digest.compactionCount} compactions`);
  if (digest.lineCount > 500) stats.push(`${digest.lineCount} transcript lines`);
  if (stats.length > 0) parts.push(`Notes: ${stats.join(', ')}`);

  return parts.join('\n');
}

/**
 * Summarize a completed session and save to daily memory.
 * Called asynchronously after session destruction.
 */
export async function summarizeSession(sessionId: string, cwd: string): Promise<void> {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '');
  const filePath = join(PATHS.SESSIONS_DIR, `${safeId}.jsonl`);

  if (!existsSync(filePath)) {
    console.log(`[SessionSummarizer] No transcript found for ${safeId}`);
    return;
  }

  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  if (lines.length < 3) {
    console.log(`[SessionSummarizer] Transcript too short for ${safeId} (${lines.length} lines)`);
    return;
  }

  const digest = parseTranscriptForSummary(lines, safeId);

  // Skip very short sessions (accidental opens)
  if (digest.durationMs < MIN_SESSION_DURATION_MS) {
    console.log(`[SessionSummarizer] Session ${safeId} too short (${Math.round(digest.durationMs / 1000)}s), skipping`);
    return;
  }

  const summary = buildSummary(digest);
  const project = cwd.split('/').pop() || 'workspace';

  // Compute pathId for path-scoped daily entry
  const pathId = resolvePathId(cwd);
  const tags = ['auto-summary'];

  // Write to both global and path-scoped daily
  appendToDaily(summary, project, tags, undefined); // global
  if (pathId) {
    appendToDaily(summary, project, tags, pathId); // path-scoped
  }

  console.log(`[SessionSummarizer] Summarized session ${safeId}: ${digest.durationMs / 1000}s, ${digest.userInputs.length} inputs, ${digest.filePaths.length} files`);
}

/**
 * Clean up old session JSONL files that have already been summarized.
 */
export async function cleanupOldSessions(maxAgeDays = 30): Promise<{ deleted: number; errors: number }> {
  if (!existsSync(PATHS.SESSIONS_DIR)) return { deleted: 0, errors: 0 };

  const files = await readdir(PATHS.SESSIONS_DIR);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;
  let errors = 0;

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = join(PATHS.SESSIONS_DIR, file);
    try {
      const s = await stat(filePath);
      if (now - s.mtimeMs > maxAgeMs) {
        await unlink(filePath);
        deleted++;
      }
    } catch {
      errors++;
    }
  }

  if (deleted > 0) {
    console.log(`[SessionSummarizer] Cleaned up ${deleted} old session files (>${maxAgeDays} days)`);
  }

  return { deleted, errors };
}
