/**
 * Unit tests for services/memory-search.ts
 *
 * Tests FTS5 search, query sanitization, BM25 ranking, Ebbinghaus decay,
 * hybrid search with RRF, and graceful degradation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock hoisted values ──
const { mockDbPrepare, mockDbClose, mockStmtAll } = vi.hoisted(() => ({
  mockDbPrepare: vi.fn(),
  mockDbClose: vi.fn(),
  mockStmtAll: vi.fn(() => []),
}));

// Mock better-sqlite3 — must export default as a constructor function (called with `new`)
vi.mock('better-sqlite3', () => {
  // Use a regular function (not arrow) so it can be called with `new`
  function MockDatabase() {
    return {
      prepare: mockDbPrepare,
      close: mockDbClose,
    };
  }
  return { default: MockDatabase };
});

// Mock memory.js PATHS
vi.mock('../../apps/runtime/src/services/memory.js', () => ({
  PATHS: {
    WORKSPACE: '/tmp/codeck-test/workspace',
    CODECK_DIR: '/tmp/codeck-test/workspace/.codeck',
    MEMORY_DIR: '/tmp/codeck-test/workspace/.codeck/memory',
    INDEX_DIR: '/tmp/codeck-test/workspace/.codeck/index',
    DAILY_DIR: '/tmp/codeck-test/workspace/.codeck/memory/daily',
    DECISIONS_DIR: '/tmp/codeck-test/workspace/.codeck/memory/decisions',
    PATHS_DIR: '/tmp/codeck-test/workspace/.codeck/memory/paths',
    SESSIONS_DIR: '/tmp/codeck-test/workspace/.codeck/sessions',
    STATE_DIR: '/tmp/codeck-test/workspace/.codeck/state',
    DURABLE_PATH: '/tmp/codeck-test/workspace/.codeck/memory/MEMORY.md',
  },
}));

// Mock embeddings
vi.mock('../../apps/runtime/src/services/embeddings.js', () => ({
  embed: vi.fn(),
  isEmbeddingsAvailable: vi.fn(() => false),
  getEmbeddingDim: vi.fn(() => 384),
}));

// Mock memory-indexer
vi.mock('../../apps/runtime/src/services/memory-indexer.js', () => ({
  isVecAvailable: vi.fn(() => false),
}));

import {
  initializeSearch,
  shutdownSearch,
  isSearchAvailable,
  search,
  hybridSearch,
} from '../../apps/runtime/src/services/memory-search.js';
import { isVecAvailable } from '../../apps/runtime/src/services/memory-indexer.js';
import { embed, isEmbeddingsAvailable } from '../../apps/runtime/src/services/embeddings.js';

describe('services/memory-search.ts - initializeSearch', () => {
  afterEach(() => {
    shutdownSearch();
  });

  it('should initialize and set available=true on success', async () => {
    const result = await initializeSearch();
    expect(result).toBe(true);
    expect(isSearchAvailable()).toBe(true);
  });

  it('should set available=false on failure', async () => {
    // Make the mock constructor throw
    const BetterSqlite3Module = await import('better-sqlite3');
    const origDefault = BetterSqlite3Module.default;
    // Temporarily replace with throwing constructor
    (BetterSqlite3Module as any).default = function() { throw new Error('SQLITE_CANTOPEN'); };

    const result = await initializeSearch();
    expect(result).toBe(false);
    expect(isSearchAvailable()).toBe(false);

    // Restore
    (BetterSqlite3Module as any).default = origDefault;
  });
});

describe('services/memory-search.ts - shutdownSearch', () => {
  it('should close db and set available=false', async () => {
    await initializeSearch();
    expect(isSearchAvailable()).toBe(true);

    shutdownSearch();
    expect(isSearchAvailable()).toBe(false);
    expect(mockDbClose).toHaveBeenCalled();
  });

  it('should be safe to call when not initialized', () => {
    shutdownSearch(); // Ensure clean state first
    expect(() => shutdownSearch()).not.toThrow();
  });
});

describe('services/memory-search.ts - search (FTS5)', () => {
  beforeEach(async () => {
    // Reset mocks but keep the chain working
    mockStmtAll.mockReturnValue([]);
    mockDbPrepare.mockReturnValue({ all: mockStmtAll });
    await initializeSearch();
  });

  afterEach(() => {
    shutdownSearch();
  });

  it('should return empty array for empty query', () => {
    const results = search({ query: '' });
    expect(results).toEqual([]);
    // prepare should not be called for empty queries
    expect(mockDbPrepare).not.toHaveBeenCalled();
  });

  it('should return empty array for whitespace-only query', () => {
    const results = search({ query: '   ' });
    expect(results).toEqual([]);
  });

  it('should construct FTS5 query with prefix matching', () => {
    search({ query: 'hello world' });

    expect(mockDbPrepare).toHaveBeenCalled();
    const sql = mockDbPrepare.mock.calls[0][0] as string;
    expect(sql).toContain('MATCH');

    // Check that the FTS query has prefix matching
    const ftsArg = mockStmtAll.mock.calls[0][0] as string;
    expect(ftsArg).toContain('"hello"*');
    expect(ftsArg).toContain('"world"*');
  });

  it('should sanitize FTS5 query (escape double quotes)', () => {
    search({ query: 'term"with"quotes' });

    const ftsArg = mockStmtAll.mock.calls[0][0] as string;
    // Double quotes should be escaped as ""
    expect(ftsArg).toContain('""');
  });

  it('should truncate queries with more than 50 terms', () => {
    const longQuery = Array.from({ length: 60 }, (_, i) => `term${i}`).join(' ');
    search({ query: longQuery });

    const ftsArg = mockStmtAll.mock.calls[0][0] as string;
    const termCount = (ftsArg.match(/"term\d+"?\*/g) || []).length;
    expect(termCount).toBe(50);
  });

  it('should apply scope filter when provided', () => {
    search({ query: 'test', scope: ['daily', 'durable'] });

    const sql = mockDbPrepare.mock.calls[0][0] as string;
    expect(sql).toContain('f.type IN');
  });

  it('should apply pathId filter when provided', () => {
    search({ query: 'test', pathId: 'abc123def456' });

    const sql = mockDbPrepare.mock.calls[0][0] as string;
    expect(sql).toContain('f.path LIKE');
  });

  it('should apply date range filters', () => {
    search({ query: 'test', dateFrom: '2025-01-01', dateTo: '2025-12-31' });

    const sql = mockDbPrepare.mock.calls[0][0] as string;
    expect(sql).toContain("json_extract(c.metadata, '$.date') >=");
    expect(sql).toContain("json_extract(c.metadata, '$.date') <=");
  });

  it('should use default limit of 20', () => {
    search({ query: 'test' });

    const sql = mockDbPrepare.mock.calls[0][0] as string;
    expect(sql).toContain('LIMIT');
    // Last param to .all() should be 20
    const allArgs = mockStmtAll.mock.calls[0];
    expect(allArgs[allArgs.length - 1]).toBe(20);
  });

  it('should apply custom limit', () => {
    search({ query: 'test', limit: 5 });

    const allArgs = mockStmtAll.mock.calls[0];
    expect(allArgs[allArgs.length - 1]).toBe(5);
  });

  it('should apply Ebbinghaus decay to daily entries', () => {
    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const recentDate = new Date().toISOString().slice(0, 10);

    mockStmtAll.mockReturnValue([
      {
        content: 'old daily entry',
        filePath: 'daily/old.md',
        fileType: 'daily',
        metadata: JSON.stringify({ date: oldDate }),
        rank: -5.0,
        snippet: 'old daily entry',
      },
      {
        content: 'recent daily entry',
        filePath: 'daily/recent.md',
        fileType: 'daily',
        metadata: JSON.stringify({ date: recentDate }),
        rank: -4.0,
        snippet: 'recent daily entry',
      },
    ]);

    const results = search({ query: 'entry' });
    expect(results).toHaveLength(2);

    // Old entry rank should be decayed (closer to 0 than original -5)
    const oldResult = results.find(r => r.content === 'old daily entry')!;
    expect(oldResult).toBeDefined();
    expect(oldResult.rank).toBeGreaterThan(-5.0); // decayed toward 0

    // Recent entry should have minimal decay
    const recentResult = results.find(r => r.content === 'recent daily entry')!;
    expect(recentResult).toBeDefined();
    expect(Math.abs(recentResult.rank - (-4.0))).toBeLessThan(0.5);
  });

  it('should NOT apply decay to durable/decision entries', () => {
    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    mockStmtAll.mockReturnValue([
      {
        content: 'durable entry',
        filePath: 'MEMORY.md',
        fileType: 'durable',
        metadata: JSON.stringify({ date: oldDate }),
        rank: -3.0,
        snippet: 'durable entry',
      },
      {
        content: 'decision entry',
        filePath: 'decisions/ADR-001.md',
        fileType: 'decision',
        metadata: JSON.stringify({ date: oldDate }),
        rank: -2.5,
        snippet: 'decision entry',
      },
    ]);

    const results = search({ query: 'entry' });
    expect(results).toHaveLength(2);

    // Durable and decision should not decay (decay factor = 1.0)
    const durableResult = results.find(r => r.fileType === 'durable')!;
    expect(durableResult).toBeDefined();
    expect(durableResult.rank).toBe(-3.0);

    const decisionResult = results.find(r => r.fileType === 'decision')!;
    expect(decisionResult).toBeDefined();
    expect(decisionResult.rank).toBe(-2.5);
  });

  it('should return empty array on SQL error', () => {
    mockDbPrepare.mockReturnValueOnce({
      all: () => { throw new Error('SQL syntax error'); },
    });

    const results = search({ query: 'test' });
    expect(results).toEqual([]);
  });

  it('should parse metadata as JSON', () => {
    mockStmtAll.mockReturnValue([
      {
        content: 'test',
        filePath: 'daily/test.md',
        fileType: 'daily',
        metadata: JSON.stringify({ date: '2025-01-01', project: 'codeck' }),
        rank: -1.0,
        snippet: 'test',
      },
    ]);

    const results = search({ query: 'test' });
    expect(results[0].metadata).toEqual({ date: '2025-01-01', project: 'codeck' });
  });

  it('should handle invalid metadata JSON gracefully', () => {
    mockStmtAll.mockReturnValue([
      {
        content: 'test',
        filePath: 'daily/test.md',
        fileType: 'daily',
        metadata: 'not valid json',
        rank: -1.0,
        snippet: 'test',
      },
    ]);

    const results = search({ query: 'test' });
    expect(results[0].metadata).toEqual({});
  });
});

describe('services/memory-search.ts - search returns empty when not initialized', () => {
  it('should return empty array when db is null', () => {
    shutdownSearch();
    const results = search({ query: 'hello' });
    expect(results).toEqual([]);
  });
});

describe('services/memory-search.ts - hybridSearch', () => {
  beforeEach(async () => {
    mockStmtAll.mockReturnValue([]);
    mockDbPrepare.mockReturnValue({ all: mockStmtAll });
    await initializeSearch();
  });

  afterEach(() => {
    shutdownSearch();
  });

  it('should fall back to BM25-only when vector search is not available', async () => {
    vi.mocked(isVecAvailable).mockReturnValue(false);
    vi.mocked(isEmbeddingsAvailable).mockReturnValue(false);

    mockStmtAll.mockReturnValue([
      {
        content: 'bm25 result',
        filePath: 'daily/test.md',
        fileType: 'daily',
        metadata: '{}',
        rank: -2.0,
        snippet: 'bm25 result',
      },
    ]);

    const results = await hybridSearch({ query: 'test' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('bm25 result');
  });

  it('should use RRF when vector search IS available', async () => {
    vi.mocked(isVecAvailable).mockReturnValue(true);
    vi.mocked(isEmbeddingsAvailable).mockReturnValue(true);
    vi.mocked(embed).mockResolvedValue(new Float32Array(384));

    // Return different results based on the SQL query
    mockDbPrepare.mockImplementation((sql: string) => {
      if (sql.includes('chunks_fts MATCH')) {
        return {
          all: () => [{
            content: 'shared result',
            filePath: 'daily/shared.md',
            fileType: 'daily',
            metadata: JSON.stringify({ date: new Date().toISOString().slice(0, 10) }),
            rank: -3.0,
            snippet: 'shared result',
          }],
        };
      }
      if (sql.includes('chunks_vec')) {
        return {
          all: () => [{
            content: 'shared result',
            filePath: 'daily/shared.md',
            fileType: 'daily',
            metadata: '{}',
            rank: 0.1,
          }],
        };
      }
      return { all: () => [] };
    });

    const results = await hybridSearch({ query: 'test' });
    // Shared result should appear once with combined RRF score
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('shared result');
    // RRF score should be positive (sum of BM25 and vec contributions)
    expect(results[0].rank).toBeGreaterThan(0);
  });

  it('should merge and deduplicate results from both sources', async () => {
    vi.mocked(isVecAvailable).mockReturnValue(true);
    vi.mocked(isEmbeddingsAvailable).mockReturnValue(true);
    vi.mocked(embed).mockResolvedValue(new Float32Array(384));

    mockDbPrepare.mockImplementation((sql: string) => {
      if (sql.includes('chunks_fts MATCH')) {
        return {
          all: () => [
            { content: 'only-bm25 result', filePath: 'a.md', fileType: 'daily', metadata: '{}', rank: -1.0, snippet: 'only-bm25' },
            { content: 'shared result content here', filePath: 'b.md', fileType: 'daily', metadata: '{}', rank: -0.5, snippet: 'shared' },
          ],
        };
      }
      if (sql.includes('chunks_vec')) {
        return {
          all: () => [
            { content: 'shared result content here', filePath: 'b.md', fileType: 'daily', metadata: '{}', rank: 0.2 },
            { content: 'only-vec result', filePath: 'c.md', fileType: 'daily', metadata: '{}', rank: 0.5 },
          ],
        };
      }
      return { all: () => [] };
    });

    const results = await hybridSearch({ query: 'test' });
    // Should have 3 unique results (shared is deduped)
    expect(results).toHaveLength(3);
    const contents = results.map(r => r.content);
    expect(contents).toContain('only-bm25 result');
    expect(contents).toContain('shared result content here');
    expect(contents).toContain('only-vec result');
  });
});
