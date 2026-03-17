/**
 * Memory API Tests — /api/memory
 *
 * Tests: durable memory, daily entries, decisions (ADR), path scopes,
 * flush with rate limiting, context assembly, and input validation.
 *
 * Uses CODECK_DIR from setup.ts (/tmp/codeck-test/.codeck) so tests
 * are isolated from live data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// The memory service derives CODECK_DIR from WORKSPACE (not from CODECK_DIR env).
// WORKSPACE is set in tests/setup.ts to /tmp/codeck-test/workspace
const TEST_WORKSPACE = process.env.WORKSPACE!;
const CODECK_DIR = join(TEST_WORKSPACE, '.codeck');
const MEMORY_DIR = join(CODECK_DIR, 'memory');

// Mock memory-search (requires SQLite which may not be available in test)
vi.mock('../../apps/runtime/src/services/memory-search.js', () => ({
  search: vi.fn(() => []),
  isSearchAvailable: vi.fn(() => false),
  hybridSearch: vi.fn(async () => []),
  isVecAvailable: vi.fn(() => false),
}));

vi.mock('../../apps/runtime/src/services/memory-indexer.js', () => ({
  indexAll: vi.fn(() => ({ success: true })),
  getIndexStats: vi.fn(() => ({ available: false })),
  isIndexerAvailable: vi.fn(() => false),
  isVecAvailable: vi.fn(() => false),
}));

vi.mock('../../apps/runtime/src/services/session-writer.js', () => ({
  listSessionFiles: vi.fn(async () => []),
  readSessionTranscript: vi.fn(async () => ({ exists: false })),
  getSessionSummary: vi.fn(async () => ({ exists: false })),
  sanitizeSecrets: vi.fn((s: string) => s),
}));

// Import memory router — it uses the memory service which reads from CODECK_DIR
import memoryRouter from '../../apps/runtime/src/routes/memory.routes.js';

describe('Memory API', () => {
  let app: Express;

  beforeEach(() => {
    // Ensure clean memory directory structure under WORKSPACE/.codeck/
    rmSync(CODECK_DIR, { recursive: true, force: true });
    mkdirSync(join(MEMORY_DIR, 'daily'), { recursive: true });
    mkdirSync(join(MEMORY_DIR, 'decisions'), { recursive: true });
    mkdirSync(join(MEMORY_DIR, 'paths'), { recursive: true });
    mkdirSync(join(CODECK_DIR, 'sessions'), { recursive: true });
    mkdirSync(join(CODECK_DIR, 'index'), { recursive: true });
    mkdirSync(join(CODECK_DIR, 'state'), { recursive: true });

    app = express();
    app.use(express.json());
    app.use('/api/memory', memoryRouter);
    // Error handler to expose errors in test output
    app.use(((err: any, _req: any, res: any, _next: any) => {
      console.error('[TEST ERROR]', err.message || err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }) as any);

    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(CODECK_DIR, { recursive: true, force: true });
  });

  // ── Durable Memory ──

  describe('Durable Memory', () => {
    it('should return exists:false when no MEMORY.md exists', async () => {
      const res = await request(app).get('/api/memory/durable').expect(200);
      expect(res.body.exists).toBe(false);
    });

    it('should write and read durable memory', async () => {
      // Write
      await request(app)
        .put('/api/memory/durable')
        .send({ content: '# Test Memory\n\nHello world' })
        .expect(200);

      // Read back
      const res = await request(app).get('/api/memory/durable').expect(200);
      expect(res.body.exists).toBe(true);
      expect(res.body.content).toContain('# Test Memory');
    });

    it('should append to a section in durable memory', async () => {
      // Create initial content
      await request(app)
        .put('/api/memory/durable')
        .send({ content: '# Memory\n\n## Notes\n\n- existing note' })
        .expect(200);

      // Append
      await request(app)
        .post('/api/memory/durable/append')
        .send({ section: 'Notes', entry: '- new note' })
        .expect(200);

      // Verify
      const res = await request(app).get('/api/memory/durable').expect(200);
      expect(res.body.content).toContain('- existing note');
      expect(res.body.content).toContain('- new note');
    });

    it('should reject write without content', async () => {
      await request(app)
        .put('/api/memory/durable')
        .send({})
        .expect(400);
    });

    it('should reject content exceeding 50KB', async () => {
      const bigContent = 'x'.repeat(51201);
      await request(app)
        .put('/api/memory/durable')
        .send({ content: bigContent })
        .expect(400);
    });

    it('should reject invalid pathId format', async () => {
      await request(app)
        .get('/api/memory/durable?pathId=notahexid')
        .expect(400);
    });
  });

  // ── Daily Entries ──

  describe('Daily Entries', () => {
    it('should write a daily entry for today', async () => {
      const res = await request(app)
        .post('/api/memory/daily')
        .send({ entry: 'Test daily entry', tags: ['test'] })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should read today daily entry after writing', async () => {
      await request(app)
        .post('/api/memory/daily')
        .send({ entry: 'First entry' })
        .expect(200);

      const res = await request(app).get('/api/memory/daily').expect(200);
      expect(res.body.exists).toBe(true);
      expect(res.body.content).toContain('First entry');
    });

    it('should list daily entries', async () => {
      await request(app)
        .post('/api/memory/daily')
        .send({ entry: 'Entry for listing' })
        .expect(200);

      const res = await request(app).get('/api/memory/daily/list').expect(200);
      expect(res.body.entries).toBeInstanceOf(Array);
      expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should reject empty entry', async () => {
      await request(app)
        .post('/api/memory/daily')
        .send({ entry: '' })
        .expect(400);
    });

    it('should reject invalid date format', async () => {
      await request(app)
        .get('/api/memory/daily?date=not-a-date')
        .expect(400);
    });

    it('should accept valid date format', async () => {
      const res = await request(app)
        .get('/api/memory/daily?date=2026-01-15')
        .expect(200);

      // May or may not exist, but should not error
      expect(res.body).toHaveProperty('exists');
    });
  });

  // ── Decisions (ADR) ──

  describe('Decisions (ADR)', () => {
    it('should create a decision', async () => {
      const res = await request(app)
        .post('/api/memory/decisions/create')
        .send({
          title: 'Use Vitest',
          context: 'Need a test framework',
          decision: 'Use Vitest with supertest',
          consequences: 'Fast tests, good DX',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.filename).toMatch(/^ADR-\d{8}-use-vitest\.md$/);
    });

    it('should list decisions after creation', async () => {
      await request(app)
        .post('/api/memory/decisions/create')
        .send({
          title: 'Test ADR',
          context: 'ctx',
          decision: 'dec',
          consequences: 'cons',
        })
        .expect(200);

      const res = await request(app).get('/api/memory/decisions/list').expect(200);
      expect(res.body.decisions).toBeInstanceOf(Array);
      expect(res.body.decisions.length).toBeGreaterThanOrEqual(1);
    });

    it('should read a specific decision by filename', async () => {
      const createRes = await request(app)
        .post('/api/memory/decisions/create')
        .send({
          title: 'Read Test',
          context: 'Testing read',
          decision: 'Should work',
          consequences: 'We know it works',
        })
        .expect(200);

      const filename = createRes.body.filename;

      const readRes = await request(app)
        .get(`/api/memory/decisions/${filename}`)
        .expect(200);

      expect(readRes.body.exists).toBe(true);
      expect(readRes.body.content).toContain('Read Test');
    });

    it('should return 404 for nonexistent decision', async () => {
      await request(app)
        .get('/api/memory/decisions/ADR-99999999-nope.md')
        .expect(404);
    });

    it('should reject creation with missing required fields', async () => {
      await request(app)
        .post('/api/memory/decisions/create')
        .send({ title: 'Missing fields' })
        .expect(400);
    });
  });

  // ── Path Scopes ──

  describe('Path Scopes', () => {
    it('should resolve a path and return a pathId', async () => {
      const res = await request(app)
        .post('/api/memory/paths/resolve')
        .send({ canonicalPath: '/workspace/test-project' })
        .expect(200);

      expect(res.body.pathId).toBeDefined();
      expect(res.body.pathId).toHaveLength(12);
      expect(res.body.pathId).toMatch(/^[a-f0-9]{12}$/);
    });

    it('should return same pathId for same path', async () => {
      const res1 = await request(app)
        .post('/api/memory/paths/resolve')
        .send({ canonicalPath: '/workspace/project-a' })
        .expect(200);

      const res2 = await request(app)
        .post('/api/memory/paths/resolve')
        .send({ canonicalPath: '/workspace/project-a' })
        .expect(200);

      expect(res1.body.pathId).toBe(res2.body.pathId);
    });

    it('should list registered paths', async () => {
      await request(app)
        .post('/api/memory/paths/resolve')
        .send({ canonicalPath: '/workspace/list-test' })
        .expect(200);

      const res = await request(app).get('/api/memory/paths').expect(200);
      expect(res.body.paths).toBeInstanceOf(Array);
      expect(res.body.paths.length).toBeGreaterThanOrEqual(1);
    });

    it('should write and read path-scoped memory', async () => {
      const resolveRes = await request(app)
        .post('/api/memory/paths/resolve')
        .send({ canonicalPath: '/workspace/scoped-project' })
        .expect(200);

      const pathId = resolveRes.body.pathId;

      // Write path-scoped memory
      await request(app)
        .put(`/api/memory/paths/${pathId}`)
        .send({ content: '# Scoped Memory' })
        .expect(200);

      // Read it back
      const readRes = await request(app)
        .get(`/api/memory/paths/${pathId}`)
        .expect(200);

      expect(readRes.body.content).toContain('# Scoped Memory');
    });

    it('should return 404 for nonexistent pathId', async () => {
      await request(app)
        .get('/api/memory/paths/aabbccddeeff')
        .expect(404);
    });

    it('should reject missing canonicalPath', async () => {
      await request(app)
        .post('/api/memory/paths/resolve')
        .send({})
        .expect(400);
    });
  });

  // ── Flush ──

  describe('Flush', () => {
    it('should flush content to daily', async () => {
      const res = await request(app)
        .post('/api/memory/flush')
        .send({ content: 'Emergency context save', scope: 'global' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.date).toBeDefined();
    });

    it('should rate-limit flush (429 on rapid second call)', async () => {
      await request(app)
        .post('/api/memory/flush')
        .send({ content: 'First flush', scope: 'global' })
        .expect(200);

      await request(app)
        .post('/api/memory/flush')
        .send({ content: 'Second flush', scope: 'global' })
        .expect(429);
    });

    it('should return flush state', async () => {
      const res = await request(app)
        .get('/api/memory/flush/state')
        .expect(200);

      // The flush state shape depends on the implementation — just verify it returns an object
      expect(res.body).toBeDefined();
      expect(typeof res.body).toBe('object');
    });

    it('should reject flush without content', async () => {
      await request(app)
        .post('/api/memory/flush')
        .send({ scope: 'global' })
        .expect(400);
    });

    it('should reject invalid scope format', async () => {
      await request(app)
        .post('/api/memory/flush')
        .send({ content: 'data', scope: 'not-valid-hex' })
        .expect(400);
    });
  });

  // ── Memory Status ──

  describe('Status & Context', () => {
    it('should return memory status', async () => {
      const res = await request(app).get('/api/memory/status').expect(200);
      // Status returns durableExists, counts, etc. — verify shape
      expect(res.body).toHaveProperty('durableExists');
    });

    it('should return assembled context', async () => {
      const res = await request(app).get('/api/memory/context').expect(200);
      expect(res.body).toHaveProperty('context');
      expect(typeof res.body.context).toBe('string');
    });

    it('should list memory files', async () => {
      const res = await request(app).get('/api/memory/files').expect(200);
      expect(res.body).toHaveProperty('files');
      expect(res.body.files).toBeInstanceOf(Array);
    });
  });

  // ── Legacy Endpoints ──

  describe('Legacy Endpoints', () => {
    it('GET /api/memory/summary should return backward-compat response', async () => {
      const res = await request(app).get('/api/memory/summary').expect(200);
      expect(res.body).toHaveProperty('exists');
    });

    it('GET /api/memory/journal should delegate to daily', async () => {
      const res = await request(app).get('/api/memory/journal').expect(200);
      expect(res.body).toHaveProperty('exists');
    });

    it('POST /api/memory/journal should delegate to daily', async () => {
      const res = await request(app)
        .post('/api/memory/journal')
        .send({ entry: 'Legacy journal entry' })
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('GET /api/memory/journal/list should delegate to daily/list', async () => {
      const res = await request(app).get('/api/memory/journal/list').expect(200);
      expect(res.body).toHaveProperty('journals');
    });
  });

  // ── Search ──

  describe('Search', () => {
    it('should return empty results when search is unavailable', async () => {
      const res = await request(app).get('/api/memory/search?q=test').expect(200);
      expect(res.body.results).toEqual([]);
      expect(res.body.available).toBe(false);
    });

    it('should return search stats', async () => {
      const res = await request(app).get('/api/memory/search/stats').expect(200);
      expect(res.body.available).toBe(false);
    });
  });

  // ── Sessions ──

  describe('Sessions', () => {
    it('should list sessions (empty when none exist)', async () => {
      const res = await request(app).get('/api/memory/sessions').expect(200);
      expect(res.body.sessions).toEqual([]);
    });

    it('should return 404 for nonexistent session', async () => {
      await request(app)
        .get('/api/memory/sessions/nonexistent-id')
        .expect(404);
    });

    it('should return 404 for nonexistent session summary', async () => {
      await request(app)
        .get('/api/memory/sessions/nonexistent-id/summary')
        .expect(404);
    });
  });
});
