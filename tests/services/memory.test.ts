/**
 * Unit tests for services/memory.ts
 *
 * Tests durable memory, daily journal, path ID resolution, atomic writes,
 * write locks, content deduplication, and directory setup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

// Mock session-writer before importing memory service
vi.mock('../../apps/runtime/src/services/session-writer.js', () => ({
  sanitizeSecrets: vi.fn((str: string) => str),
  startSessionCapture: vi.fn(),
  captureInput: vi.fn(),
  captureOutput: vi.fn(),
  endSessionCapture: vi.fn(),
}));

import {
  atomicWriteFileSync,
  computePathId,
  sanitizePathId,
  resolvePathId,
  listPathScopes,
  getPathMapping,
  ensureDirectories,
  getDurableMemory,
  writeDurableMemory,
  appendToDurableMemory,
  getDailyEntry,
  appendToDaily,
  listDailyEntries,
  createDecision,
  listDecisions,
  getDecision,
  assembleContext,
  flush,
  getFlushState,
  getMemoryStatus,
  PATHS,
} from '../../apps/runtime/src/services/memory.js';

const WORKSPACE = process.env.WORKSPACE!;
const CODECK_DIR = join(WORKSPACE, '.codeck');
const MEMORY_DIR = join(CODECK_DIR, 'memory');
const DAILY_DIR = join(MEMORY_DIR, 'daily');
const DECISIONS_DIR = join(MEMORY_DIR, 'decisions');
const PATHS_DIR = join(MEMORY_DIR, 'paths');
const STATE_DIR = join(CODECK_DIR, 'state');
const DURABLE_PATH = join(MEMORY_DIR, 'MEMORY.md');

describe('services/memory.ts - PATHS export', () => {
  it('should export all canonical paths relative to WORKSPACE env', () => {
    expect(PATHS.WORKSPACE).toBe(resolve(WORKSPACE));
    expect(PATHS.CODECK_DIR).toContain('.codeck');
    expect(PATHS.MEMORY_DIR).toContain('memory');
    expect(PATHS.DAILY_DIR).toContain('daily');
    expect(PATHS.DECISIONS_DIR).toContain('decisions');
    expect(PATHS.PATHS_DIR).toContain('paths');
    expect(PATHS.STATE_DIR).toContain('state');
    expect(PATHS.DURABLE_PATH).toContain('MEMORY.md');
  });
});

describe('services/memory.ts - atomicWriteFileSync', () => {
  const testDir = join(WORKSPACE, '.codeck', 'memory');
  const testFile = join(testDir, 'atomic-test.txt');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    if (existsSync(testFile)) rmSync(testFile);
  });

  afterEach(() => {
    if (existsSync(testFile)) rmSync(testFile);
  });

  it('should write file atomically (content readable after write)', () => {
    atomicWriteFileSync(testFile, 'hello world');
    expect(existsSync(testFile)).toBe(true);
    expect(readFileSync(testFile, 'utf-8')).toBe('hello world');
  });

  it('should overwrite existing file content', () => {
    writeFileSync(testFile, 'old content');
    atomicWriteFileSync(testFile, 'new content');
    expect(readFileSync(testFile, 'utf-8')).toBe('new content');
  });

  it('should not leave temp files on success', () => {
    atomicWriteFileSync(testFile, 'data');
    const dirContents = require('fs').readdirSync(testDir);
    const tmpFiles = dirContents.filter((f: string) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('should set file mode when specified', () => {
    atomicWriteFileSync(testFile, 'secret', { mode: 0o600 });
    const mode = statSync(testFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('services/memory.ts - Path ID system', () => {
  beforeEach(() => {
    // Clean state dir
    const pathsMapFile = join(STATE_DIR, 'paths.json');
    if (existsSync(pathsMapFile)) rmSync(pathsMapFile);
    // Clean paths dir
    if (existsSync(PATHS_DIR)) rmSync(PATHS_DIR, { recursive: true });
    mkdirSync(PATHS_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });
  });

  it('computePathId should return deterministic 12-char hex hash', () => {
    const id1 = computePathId('/workspace/project-a');
    const id2 = computePathId('/workspace/project-a');
    const id3 = computePathId('/workspace/project-b');

    expect(id1).toBe(id2); // Same input = same output
    expect(id1).not.toBe(id3); // Different input = different output
    expect(id1).toMatch(/^[a-f0-9]{12}$/); // 12 hex chars
  });

  it('sanitizePathId should accept valid 12-char hex', () => {
    expect(sanitizePathId('abcdef012345')).toBe('abcdef012345');
  });

  it('sanitizePathId should reject short strings', () => {
    expect(sanitizePathId('abc')).toBeNull();
    expect(sanitizePathId('')).toBeNull();
  });

  it('sanitizePathId should strip non-hex characters and reject if too short', () => {
    expect(sanitizePathId('abcXYZ012345')).toBeNull(); // X,Y,Z stripped -> only 9 chars
  });

  it('sanitizePathId should truncate long input to 12 chars', () => {
    expect(sanitizePathId('abcdef012345ffff')).toBe('abcdef012345');
  });

  it('resolvePathId should create path mapping on first call', () => {
    const pathId = resolvePathId('/workspace/test-project');
    expect(pathId).toMatch(/^[a-f0-9]{12}$/);

    const mapping = getPathMapping(pathId);
    expect(mapping).not.toBeNull();
    expect(mapping!.canonicalPath).toBe(resolve('/workspace/test-project'));
    expect(mapping!.name).toBe('test-project');
    expect(typeof mapping!.createdAt).toBe('number');
  });

  it('resolvePathId should return same pathId for same path', () => {
    const id1 = resolvePathId('/workspace/my-app');
    const id2 = resolvePathId('/workspace/my-app');
    expect(id1).toBe(id2);
  });

  it('resolvePathId should create path-scoped directories', () => {
    const pathId = resolvePathId('/workspace/scoped-test');
    const pathDir = join(PATHS_DIR, pathId);
    const pathDailyDir = join(pathDir, 'daily');

    expect(existsSync(pathDir)).toBe(true);
    expect(existsSync(pathDailyDir)).toBe(true);
  });

  it('listPathScopes should return all registered paths sorted by createdAt desc', () => {
    resolvePathId('/workspace/aaa');
    resolvePathId('/workspace/bbb');
    resolvePathId('/workspace/ccc');

    const scopes = listPathScopes();
    expect(scopes).toHaveLength(3);
    // Most recent first
    expect(scopes[0].createdAt).toBeGreaterThanOrEqual(scopes[1].createdAt);
  });
});

describe('services/memory.ts - ensureDirectories', () => {
  it('should create all required directories without throwing', () => {
    // Clean up first
    for (const dir of [MEMORY_DIR, DAILY_DIR, DECISIONS_DIR, PATHS_DIR]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true });
    }

    ensureDirectories();

    expect(existsSync(MEMORY_DIR)).toBe(true);
    expect(existsSync(DAILY_DIR)).toBe(true);
    expect(existsSync(DECISIONS_DIR)).toBe(true);
    expect(existsSync(PATHS_DIR)).toBe(true);
  });
});

describe('services/memory.ts - Durable Memory (MEMORY.md)', () => {
  beforeEach(() => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    if (existsSync(DURABLE_PATH)) rmSync(DURABLE_PATH);
  });

  afterEach(() => {
    if (existsSync(DURABLE_PATH)) rmSync(DURABLE_PATH);
  });

  it('getDurableMemory should return exists=false when no file', () => {
    const result = getDurableMemory();
    expect(result.exists).toBe(false);
    expect(result.content).toBeNull();
  });

  it('writeDurableMemory should create MEMORY.md', async () => {
    await writeDurableMemory('# Global Memory\n\nHello');
    expect(existsSync(DURABLE_PATH)).toBe(true);

    const result = getDurableMemory();
    expect(result.exists).toBe(true);
    expect(result.content).toContain('# Global Memory');
  });

  it('writeDurableMemory should overwrite existing content', async () => {
    await writeDurableMemory('first version');
    await writeDurableMemory('second version');

    const result = getDurableMemory();
    expect(result.content).toBe('second version');
  });

  it('appendToDurableMemory should create new section if not present', async () => {
    await writeDurableMemory('# Memory\n\n## Existing\n\nsome content');
    await appendToDurableMemory('NewSection', 'entry one');

    const result = getDurableMemory();
    expect(result.content).toContain('## NewSection');
    expect(result.content).toContain('entry one');
  });

  it('appendToDurableMemory should append to existing section', async () => {
    await writeDurableMemory('# Memory\n\n## Notes\n\nfirst note\n\n## Other\n\nstuff');
    await appendToDurableMemory('Notes', 'second note');

    const result = getDurableMemory();
    expect(result.content).toContain('first note');
    expect(result.content).toContain('second note');
    // second note should be before ## Other
    const notesIdx = result.content!.indexOf('second note');
    const otherIdx = result.content!.indexOf('## Other');
    expect(notesIdx).toBeLessThan(otherIdx);
  });

  it('appendToDurableMemory should create file if not exists', async () => {
    await appendToDurableMemory('Fresh', 'brand new entry');
    const result = getDurableMemory();
    expect(result.exists).toBe(true);
    expect(result.content).toContain('## Fresh');
    expect(result.content).toContain('brand new entry');
  });

  it('getDurableMemory with pathId should read path-scoped memory', async () => {
    const pathId = resolvePathId('/workspace/path-memory-test');
    await writeDurableMemory('# Path-scoped content', pathId);

    const result = getDurableMemory(pathId);
    expect(result.exists).toBe(true);
    expect(result.content).toContain('Path-scoped content');

    // Global should not contain it
    const global = getDurableMemory();
    if (global.content) {
      expect(global.content).not.toContain('Path-scoped content');
    }
  });
});

describe('services/memory.ts - Write lock behavior', () => {
  beforeEach(() => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    if (existsSync(DURABLE_PATH)) rmSync(DURABLE_PATH);
  });

  afterEach(() => {
    if (existsSync(DURABLE_PATH)) rmSync(DURABLE_PATH);
  });

  it('should handle concurrent writes without corruption', async () => {
    await writeDurableMemory('initial');

    // Fire 5 concurrent appends
    const promises = Array.from({ length: 5 }, (_, i) =>
      appendToDurableMemory('Concurrent', `entry-${i}`)
    );
    await Promise.all(promises);

    const result = getDurableMemory();
    expect(result.exists).toBe(true);
    // All entries should be present
    for (let i = 0; i < 5; i++) {
      expect(result.content).toContain(`entry-${i}`);
    }
  });

  it('should handle concurrent daily writes', async () => {
    mkdirSync(DAILY_DIR, { recursive: true });

    const promises = Array.from({ length: 3 }, (_, i) =>
      appendToDaily(`concurrent daily entry ${i}`, 'test-project', ['concurrency'])
    );
    await Promise.all(promises);

    // All should appear in today's daily
    const entry = getDailyEntry();
    expect(entry.exists).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(entry.content).toContain(`concurrent daily entry ${i}`);
    }
  });
});

describe('services/memory.ts - Daily journal', () => {
  beforeEach(() => {
    mkdirSync(DAILY_DIR, { recursive: true });
    // Clean today's daily
    const today = new Date().toISOString().slice(0, 10);
    const todayPath = join(DAILY_DIR, `${today}.md`);
    if (existsSync(todayPath)) rmSync(todayPath);
  });

  afterEach(() => {
    const today = new Date().toISOString().slice(0, 10);
    const todayPath = join(DAILY_DIR, `${today}.md`);
    if (existsSync(todayPath)) rmSync(todayPath);
  });

  it('getDailyEntry should return exists=false when no file', () => {
    const result = getDailyEntry('2099-01-01');
    expect(result.exists).toBe(false);
    expect(result.date).toBe('2099-01-01');
    expect(result.content).toBeNull();
  });

  it('appendToDaily should create daily file with header', async () => {
    const result = await appendToDaily('test entry');
    const today = new Date().toISOString().slice(0, 10);
    expect(result.date).toBe(today);

    const entry = getDailyEntry(today);
    expect(entry.exists).toBe(true);
    expect(entry.content).toContain(`# Daily — ${today}`);
    expect(entry.content).toContain('test entry');
  });

  it('appendToDaily should include timestamp, project and tags', async () => {
    await appendToDaily('tagged entry', 'my-project', ['tag1', 'tag2']);

    const entry = getDailyEntry();
    expect(entry.content).toContain('[my-project]');
    expect(entry.content).toContain('#tag1');
    expect(entry.content).toContain('#tag2');
    expect(entry.content).toContain('tagged entry');
    // Timestamp format HH:MM:SS
    expect(entry.content).toMatch(/###\s+\d{2}:\d{2}:\d{2}/);
  });

  it('appendToDaily should append to existing file', async () => {
    await appendToDaily('first entry');
    await appendToDaily('second entry with different content');

    const entry = getDailyEntry();
    expect(entry.content).toContain('first entry');
    expect(entry.content).toContain('second entry');
  });

  it('appendToDaily should skip near-duplicate entries (>85% overlap)', async () => {
    const text = 'the quick brown fox jumps over the lazy dog repeatedly';
    await appendToDaily(text);
    await appendToDaily(text); // Exact duplicate

    const entry = getDailyEntry();
    // Should only contain one instance of the text (header + entry)
    const matches = entry.content!.match(/quick brown fox/g);
    expect(matches).toHaveLength(1);
  });

  it('listDailyEntries should return sorted entries by date descending', () => {
    // Create a few manual daily files
    writeFileSync(join(DAILY_DIR, '2025-01-01.md'), '# Day 1');
    writeFileSync(join(DAILY_DIR, '2025-01-03.md'), '# Day 3');
    writeFileSync(join(DAILY_DIR, '2025-01-02.md'), '# Day 2');

    const entries = listDailyEntries();
    expect(entries.length).toBeGreaterThanOrEqual(3);

    // Find our test entries
    const testEntries = entries.filter(e => e.date.startsWith('2025-01'));
    expect(testEntries[0].date).toBe('2025-01-03');
    expect(testEntries[1].date).toBe('2025-01-02');
    expect(testEntries[2].date).toBe('2025-01-01');

    // Each entry should have size > 0
    for (const e of testEntries) {
      expect(e.size).toBeGreaterThan(0);
    }

    // Cleanup
    rmSync(join(DAILY_DIR, '2025-01-01.md'));
    rmSync(join(DAILY_DIR, '2025-01-02.md'));
    rmSync(join(DAILY_DIR, '2025-01-03.md'));
  });

  it('listDailyEntries should return empty array for non-existent dir', () => {
    const entries = listDailyEntries('nonexistent-path-id');
    expect(entries).toEqual([]);
  });
});

describe('services/memory.ts - Decisions (ADR)', () => {
  beforeEach(() => {
    mkdirSync(DECISIONS_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean decisions
    if (existsSync(DECISIONS_DIR)) {
      const files = require('fs').readdirSync(DECISIONS_DIR);
      for (const f of files) {
        if (f.startsWith('ADR-')) rmSync(join(DECISIONS_DIR, f));
      }
    }
  });

  it('createDecision should create ADR file with proper format', () => {
    const result = createDecision(
      'Use SQLite for Search',
      'We need full-text search for memory',
      'Use SQLite FTS5',
      'Fast search, no external deps'
    );

    expect(result.filename).toMatch(/^ADR-\d{8}-\d{6}-use-sqlite-for-search\.md$/);
    const content = readFileSync(join(DECISIONS_DIR, result.filename), 'utf-8');
    expect(content).toContain('# Use SQLite for Search');
    expect(content).toContain('**Status**: Accepted');
    expect(content).toContain('## Context');
    expect(content).toContain('## Decision');
    expect(content).toContain('## Consequences');
  });

  it('listDecisions should list all ADRs sorted by filename desc', () => {
    createDecision('First Decision', 'ctx', 'dec', 'cons');
    createDecision('Second Decision', 'ctx', 'dec', 'cons');

    const decisions = listDecisions();
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    // Most recent first (higher filename = more recent)
    expect(decisions[0].filename > decisions[1].filename).toBe(true);
  });

  it('getDecision should return content for existing file', () => {
    const { filename } = createDecision('Test ADR', 'context', 'decision', 'consequences');
    const result = getDecision(filename);
    expect(result.exists).toBe(true);
    expect(result.content).toContain('# Test ADR');
  });

  it('getDecision should return exists=false for non-existent file', () => {
    const result = getDecision('ADR-nonexistent.md');
    expect(result.exists).toBe(false);
    expect(result.content).toBeNull();
  });

  it('getDecision should sanitize filename to prevent path traversal', () => {
    const result = getDecision('../../etc/passwd');
    expect(result.exists).toBe(false);
  });
});

describe('services/memory.ts - Flush with cooldown', () => {
  const flushStateFile = join(STATE_DIR, 'flush_state.json');

  beforeEach(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    mkdirSync(DAILY_DIR, { recursive: true });
    if (existsSync(flushStateFile)) rmSync(flushStateFile);
    // Clean today's daily
    const today = new Date().toISOString().slice(0, 10);
    const todayPath = join(DAILY_DIR, `${today}.md`);
    if (existsSync(todayPath)) rmSync(todayPath);
  });

  afterEach(() => {
    if (existsSync(flushStateFile)) rmSync(flushStateFile);
    const today = new Date().toISOString().slice(0, 10);
    const todayPath = join(DAILY_DIR, `${today}.md`);
    if (existsSync(todayPath)) rmSync(todayPath);
  });

  it('flush should succeed on first call', async () => {
    const result = await flush('important data', 'global');
    expect(result.success).toBe(true);
    expect(result.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('flush should be rate-limited per scope (30s cooldown)', async () => {
    const first = await flush('data 1', 'test-scope');
    expect(first.success).toBe(true);

    const second = await flush('data 2', 'test-scope');
    expect(second.success).toBe(false);
    expect(second.reason).toContain('cooldown');
    expect(second.cooldownRemaining).toBeGreaterThan(0);
  });

  it('flush should allow different scopes independently', async () => {
    const r1 = await flush('data for scope-a', 'scope-a');
    const r2 = await flush('data for scope-b', 'scope-b');
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it('getFlushState should return flush timestamps', async () => {
    await flush('data', 'tracked-scope');
    const state = getFlushState();
    expect(state['tracked-scope']).toBeDefined();
    expect(state['tracked-scope'].lastFlushAt).toBeGreaterThan(0);
    expect(state['tracked-scope'].lastFlushBytes).toBeGreaterThan(0);
  });
});

describe('services/memory.ts - assembleContext', () => {
  beforeEach(() => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    mkdirSync(DAILY_DIR, { recursive: true });
    if (existsSync(DURABLE_PATH)) rmSync(DURABLE_PATH);
  });

  afterEach(() => {
    if (existsSync(DURABLE_PATH)) rmSync(DURABLE_PATH);
    const today = new Date().toISOString().slice(0, 10);
    const todayPath = join(DAILY_DIR, `${today}.md`);
    if (existsSync(todayPath)) rmSync(todayPath);
  });

  it('should return empty string when no memory exists', () => {
    const ctx = assembleContext();
    expect(ctx).toBe('');
  });

  it('should include durable memory when present', async () => {
    await writeDurableMemory('# Global\n\nImportant facts');
    const ctx = assembleContext();
    expect(ctx).toContain('# Durable Memory');
    expect(ctx).toContain('Important facts');
  });

  it('should include today daily when present', async () => {
    await writeDurableMemory('# Mem');
    await appendToDaily('did some work today');
    const ctx = assembleContext();
    expect(ctx).toContain("Today's Daily");
    expect(ctx).toContain('did some work today');
  });

  it('should include path-scoped memory when pathId provided', async () => {
    const pathId = resolvePathId('/workspace/ctx-test-project');
    await writeDurableMemory('# Project-specific stuff', pathId);
    const ctx = assembleContext(pathId);
    expect(ctx).toContain(`Path Memory (${pathId})`);
    expect(ctx).toContain('Project-specific stuff');
  });
});

describe('services/memory.ts - getMemoryStatus', () => {
  beforeEach(() => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    mkdirSync(DAILY_DIR, { recursive: true });
    mkdirSync(DECISIONS_DIR, { recursive: true });
  });

  it('should return status object with expected keys', async () => {
    const status = await getMemoryStatus();
    expect(status).toHaveProperty('durableExists');
    expect(status).toHaveProperty('dailyCount');
    expect(status).toHaveProperty('decisionsCount');
    expect(status).toHaveProperty('sessionsCount');
    expect(status).toHaveProperty('pathScopes');
    expect(typeof status.dailyCount).toBe('number');
  });
});
