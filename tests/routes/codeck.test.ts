/**
 * Codeck API Tests — /api/codeck
 *
 * Tests: file listing, reading, writing, env var management,
 * path traversal protection.
 * Uses real filesystem under /tmp/codeck-test/ (from setup.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// The codeck routes read from WORKSPACE env (set in setup.ts)
const TEST_WORKSPACE = process.env.WORKSPACE!;
const AGENT_DATA_DIR = join(TEST_WORKSPACE, '.codeck');
const ENV_FILE = join(AGENT_DATA_DIR, '.env');
const ENV_ENCRYPTED_FILE = join(AGENT_DATA_DIR, '.env.encrypted');

// Mock syncEnvToMcpServers — it reads .claude.json which we don't want in tests.
// The route file imports fs directly (readFileSync/writeFileSync), and we need
// the CLAUDE_JSON_PATH to point somewhere safe.
// We'll set HOME to our test root so .claude.json goes to /tmp/codeck-test/.claude.json
const TEST_HOME = '/tmp/codeck-test';
const originalHome = process.env.HOME;

// Mock child_process to prevent real spawn/execFile calls (used by export/import)
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    spawn: vi.fn(() => {
      const { EventEmitter } = require('events');
      const { Readable } = require('stream');
      const emitter = new EventEmitter();
      emitter.stdout = new Readable({ read() { this.push(null); } });
      emitter.stderr = new Readable({ read() { this.push(null); } });
      setTimeout(() => emitter.emit('close', 0), 10);
      return emitter;
    }),
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      if (cb) cb(null, '', '');
    }),
  };
});

import codeckRouter from '../../apps/runtime/src/routes/codeck.routes.js';

describe('Codeck API', () => {
  let app: Express;

  beforeEach(() => {
    // Set HOME to test path so .claude.json operations stay isolated
    process.env.HOME = TEST_HOME;

    // Clean up and recreate test directories
    rmSync(AGENT_DATA_DIR, { recursive: true, force: true });
    mkdirSync(AGENT_DATA_DIR, { recursive: true });

    // Create a .claude.json in the test home
    const claudeJsonPath = join(TEST_HOME, '.claude.json');
    if (!existsSync(join(TEST_HOME))) {
      mkdirSync(TEST_HOME, { recursive: true });
    }
    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: {} }, null, 2));

    app = express();
    app.use(express.json());
    app.use('/api/codeck', codeckRouter);

    vi.clearAllMocks();
  });

  // ── GET /api/codeck/files ──

  describe('GET /api/codeck/files', () => {
    it('should list .codeck directory contents', async () => {
      // Create test files and directories
      mkdirSync(join(AGENT_DATA_DIR, 'memory'), { recursive: true });
      writeFileSync(join(AGENT_DATA_DIR, 'preferences.md'), '# Preferences');

      const res = await request(app).get('/api/codeck/files').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.items).toBeDefined();
      expect(Array.isArray(res.body.items)).toBe(true);

      const names = res.body.items.map((i: { name: string }) => i.name);
      expect(names).toContain('memory');
      expect(names).toContain('preferences.md');
    });

    it('should list subdirectory contents', async () => {
      mkdirSync(join(AGENT_DATA_DIR, 'memory', 'daily'), { recursive: true });
      writeFileSync(join(AGENT_DATA_DIR, 'memory', 'test.md'), 'content');

      const res = await request(app)
        .get('/api/codeck/files?path=memory')
        .expect(200);

      expect(res.body.success).toBe(true);
      const names = res.body.items.map((i: { name: string }) => i.name);
      expect(names).toContain('daily');
      expect(names).toContain('test.md');
    });

    it('should sort directories before files', async () => {
      mkdirSync(join(AGENT_DATA_DIR, 'rules'), { recursive: true });
      writeFileSync(join(AGENT_DATA_DIR, 'aaa.txt'), 'content');

      const res = await request(app).get('/api/codeck/files').expect(200);

      const items = res.body.items;
      const dirIdx = items.findIndex((i: { name: string }) => i.name === 'rules');
      const fileIdx = items.findIndex((i: { name: string }) => i.name === 'aaa.txt');
      expect(dirIdx).toBeLessThan(fileIdx);
    });

    it('should return empty items for nonexistent path', async () => {
      const res = await request(app)
        .get('/api/codeck/files?path=nonexistent')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.items).toEqual([]);
    });

    it('should return 403 for path traversal attempt', async () => {
      const res = await request(app)
        .get('/api/codeck/files?path=../../etc')
        .expect(403);

      expect(res.body.error).toBe('Access denied');
    });

    it('should filter by type=dir', async () => {
      mkdirSync(join(AGENT_DATA_DIR, 'memory'), { recursive: true });
      writeFileSync(join(AGENT_DATA_DIR, 'test.md'), 'content');

      const res = await request(app)
        .get('/api/codeck/files?type=dir')
        .expect(200);

      expect(res.body.success).toBe(true);
      const allDirs = res.body.items.every((i: { isDirectory: boolean }) => i.isDirectory);
      expect(allDirs).toBe(true);
    });
  });

  // ── GET /api/codeck/files/read ──

  describe('GET /api/codeck/files/read', () => {
    it('should read a file', async () => {
      writeFileSync(join(AGENT_DATA_DIR, 'test.md'), '# Hello World');

      const res = await request(app)
        .get('/api/codeck/files/read?path=test.md')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.content).toBe('# Hello World');
      expect(res.body.size).toBeGreaterThan(0);
    });

    it('should return 400 when path is missing', async () => {
      const res = await request(app)
        .get('/api/codeck/files/read')
        .expect(400);

      expect(res.body.error).toBe('path required');
    });

    it('should return 404 for nonexistent file', async () => {
      const res = await request(app)
        .get('/api/codeck/files/read?path=nonexistent.md')
        .expect(404);

      expect(res.body.error).toBe('File not found');
    });

    it('should return 403 for path traversal', async () => {
      const res = await request(app)
        .get('/api/codeck/files/read?path=../../etc/passwd')
        .expect(403);

      expect(res.body.error).toBe('Access denied');
    });

    it('should reject files larger than 100KB', async () => {
      const largeContent = 'x'.repeat(101 * 1024);
      writeFileSync(join(AGENT_DATA_DIR, 'large.txt'), largeContent);

      const res = await request(app)
        .get('/api/codeck/files/read?path=large.txt')
        .expect(200);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('File too large');
    });
  });

  // ── PUT /api/codeck/files/write ──

  describe('PUT /api/codeck/files/write', () => {
    it('should write a new file', async () => {
      const res = await request(app)
        .put('/api/codeck/files/write')
        .send({ path: 'new-file.md', content: '# New File' })
        .expect(200);

      expect(res.body.success).toBe(true);

      const content = readFileSync(join(AGENT_DATA_DIR, 'new-file.md'), 'utf-8');
      expect(content).toBe('# New File');
    });

    it('should update an existing file', async () => {
      writeFileSync(join(AGENT_DATA_DIR, 'existing.md'), 'old content');

      const res = await request(app)
        .put('/api/codeck/files/write')
        .send({ path: 'existing.md', content: 'updated content' })
        .expect(200);

      expect(res.body.success).toBe(true);

      const content = readFileSync(join(AGENT_DATA_DIR, 'existing.md'), 'utf-8');
      expect(content).toBe('updated content');
    });

    it('should return 400 when path is missing', async () => {
      const res = await request(app)
        .put('/api/codeck/files/write')
        .send({ content: 'test' })
        .expect(400);

      expect(res.body.error).toBe('path and content required');
    });

    it('should return 400 when content is missing', async () => {
      const res = await request(app)
        .put('/api/codeck/files/write')
        .send({ path: 'test.md' })
        .expect(400);

      expect(res.body.error).toBe('path and content required');
    });

    it('should return 400 when content is not a string', async () => {
      const res = await request(app)
        .put('/api/codeck/files/write')
        .send({ path: 'test.md', content: 123 })
        .expect(400);

      expect(res.body.error).toBe('path and content required');
    });

    it('should return 403 for path traversal', async () => {
      const res = await request(app)
        .put('/api/codeck/files/write')
        .send({ path: '../../etc/passwd', content: 'hacked' })
        .expect(403);

      expect(res.body.error).toBe('Access denied');
    });

    it('should create parent directories if needed', async () => {
      const res = await request(app)
        .put('/api/codeck/files/write')
        .send({ path: 'rules/user/custom.md', content: '# Custom Rule' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(existsSync(join(AGENT_DATA_DIR, 'rules', 'user', 'custom.md'))).toBe(true);
    });
  });

  // ── POST /api/codeck/env ──

  describe('POST /api/codeck/env', () => {
    it('should set a valid env var with UPPER_SNAKE_CASE key', async () => {
      const res = await request(app)
        .post('/api/codeck/env')
        .send({ key: 'MY_API_KEY', value: 'secret-value-123' })
        .expect(200);

      expect(res.body.success).toBe(true);

      // Verify encrypted file was written (not plaintext)
      expect(existsSync(ENV_ENCRYPTED_FILE)).toBe(true);
      const store = JSON.parse(readFileSync(ENV_ENCRYPTED_FILE, 'utf-8'));
      expect(store.version).toBe(1);
      expect(store.vars).toHaveLength(1);
      expect(store.vars[0].key).toBe('MY_API_KEY');
      // Value should be encrypted (has iv and tag fields)
      expect(store.vars[0].value).toHaveProperty('encrypted');
      expect(store.vars[0].value).toHaveProperty('iv');
      expect(store.vars[0].value).toHaveProperty('tag');
    });

    it('should update an existing env var', async () => {
      // Write initial var via API (encrypted)
      await request(app)
        .post('/api/codeck/env')
        .send({ key: 'MY_API_KEY', value: 'old-value' });

      const res = await request(app)
        .post('/api/codeck/env')
        .send({ key: 'MY_API_KEY', value: 'new-value' })
        .expect(200);

      expect(res.body.success).toBe(true);

      // Verify only one var in encrypted store
      const store = JSON.parse(readFileSync(ENV_ENCRYPTED_FILE, 'utf-8'));
      expect(store.vars).toHaveLength(1);
      expect(store.vars[0].key).toBe('MY_API_KEY');
    });

    it('should return 400 for invalid key format (lowercase)', async () => {
      const res = await request(app)
        .post('/api/codeck/env')
        .send({ key: 'my-invalid-key', value: 'test' })
        .expect(400);

      expect(res.body.error).toContain('Invalid key');
    });

    it('should return 400 for invalid key format (special chars)', async () => {
      const res = await request(app)
        .post('/api/codeck/env')
        .send({ key: 'KEY WITH SPACES', value: 'test' })
        .expect(400);

      expect(res.body.error).toContain('Invalid key');
    });

    it('should return 400 for missing key', async () => {
      const res = await request(app)
        .post('/api/codeck/env')
        .send({ value: 'test' })
        .expect(400);

      expect(res.body.error).toContain('Invalid key');
    });

    it('should return 400 for non-string value', async () => {
      const res = await request(app)
        .post('/api/codeck/env')
        .send({ key: 'MY_KEY', value: 42 })
        .expect(400);

      expect(res.body.error).toContain('Value required');
    });

    it('should accept keys starting with underscore', async () => {
      const res = await request(app)
        .post('/api/codeck/env')
        .send({ key: '_INTERNAL_VAR', value: 'test' })
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  // ── GET /api/codeck/env ──

  describe('GET /api/codeck/env', () => {
    it('should list env var keys (without values)', async () => {
      writeFileSync(ENV_FILE, 'API_KEY=secret\nDB_HOST=localhost\n', { mode: 0o600 });

      const res = await request(app).get('/api/codeck/env').expect(200);

      expect(res.body.vars).toHaveLength(2);
      expect(res.body.vars[0].key).toBe('API_KEY');
      expect(res.body.vars[0].hasValue).toBe(true);
      // Verify values are not exposed
      expect(res.body.vars[0].value).toBeUndefined();
    });

    it('should return empty array when no env file exists', async () => {
      const res = await request(app).get('/api/codeck/env').expect(200);

      expect(res.body.vars).toEqual([]);
    });

    it('should skip comments and empty lines', async () => {
      writeFileSync(ENV_FILE, '# Comment\n\nVALID_KEY=value\n', { mode: 0o600 });

      const res = await request(app).get('/api/codeck/env').expect(200);

      expect(res.body.vars).toHaveLength(1);
      expect(res.body.vars[0].key).toBe('VALID_KEY');
    });
  });

  // ── DELETE /api/codeck/env ──

  describe('DELETE /api/codeck/env', () => {
    it('should delete an env var', async () => {
      // Set up two vars via API
      await request(app).post('/api/codeck/env').send({ key: 'KEY_A', value: 'val1' });
      await request(app).post('/api/codeck/env').send({ key: 'KEY_B', value: 'val2' });

      const res = await request(app)
        .delete('/api/codeck/env')
        .send({ key: 'KEY_A' })
        .expect(200);

      expect(res.body.success).toBe(true);

      const store = JSON.parse(readFileSync(ENV_ENCRYPTED_FILE, 'utf-8'));
      const keys = store.vars.map((v: { key: string }) => v.key);
      expect(keys).not.toContain('KEY_A');
      expect(keys).toContain('KEY_B');
    });

    it('should return 400 for missing key', async () => {
      const res = await request(app)
        .delete('/api/codeck/env')
        .send({})
        .expect(400);

      expect(res.body.error).toContain('Key required');
    });

    it('should handle deleting nonexistent key gracefully', async () => {
      // Set up a var via API
      await request(app).post('/api/codeck/env').send({ key: 'EXISTING', value: 'value' });

      const res = await request(app)
        .delete('/api/codeck/env')
        .send({ key: 'NONEXISTENT' })
        .expect(200);

      expect(res.body.success).toBe(true);

      // Original key should still be there
      const store = JSON.parse(readFileSync(ENV_ENCRYPTED_FILE, 'utf-8'));
      expect(store.vars.some((v: { key: string }) => v.key === 'EXISTING')).toBe(true);
    });
  });

  // ── GET /api/codeck/export ──

  describe('GET /api/codeck/export', () => {
    it('should return a gzip response with correct headers', async () => {
      // AGENT_DATA_DIR exists (created in beforeEach), so export should proceed
      writeFileSync(join(AGENT_DATA_DIR, 'preferences.md'), '# Prefs');

      const res = await request(app)
        .get('/api/codeck/export')
        .expect(200);

      expect(res.headers['content-type']).toContain('application/gzip');
      expect(res.headers['content-disposition']).toContain('codeck-memory-');
      expect(res.headers['content-disposition']).toContain('.tar.gz');
    });

    it('should include date in the filename', async () => {
      const res = await request(app)
        .get('/api/codeck/export')
        .expect(200);

      const today = new Date().toISOString().slice(0, 10);
      expect(res.headers['content-disposition']).toContain(today);
    });
  });

  // ── POST /api/codeck/import ──

  describe('POST /api/codeck/import', () => {
    it('should return 400 when data is missing', async () => {
      const res = await request(app)
        .post('/api/codeck/import')
        .send({})
        .expect(400);

      expect(res.body.error).toContain('Base64-encoded tar.gz data required');
    });

    it('should return 400 when data is not a string', async () => {
      const res = await request(app)
        .post('/api/codeck/import')
        .send({ data: 12345 })
        .expect(400);

      expect(res.body.error).toContain('Base64-encoded tar.gz data required');
    });

    it('should return 400 for empty base64 data', async () => {
      // An empty string still passes the typeof check, but decodes to 0 bytes
      const res = await request(app)
        .post('/api/codeck/import')
        .send({ data: '' })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it('should accept a valid base64 string (spawn is mocked)', async () => {
      // Create minimal base64 data (won't be a real tar.gz but spawn is mocked)
      const fakeData = Buffer.from('fake-tar-data').toString('base64');

      const res = await request(app)
        .post('/api/codeck/import')
        .send({ data: fakeData })
        .expect(200);

      // spawn is mocked to succeed, so it should report success with 0 imported items
      // (since the mocked tar doesn't actually extract anything)
      expect(res.body.success).toBe(true);
      expect(res.body.imported).toBeDefined();
    });
  });
});
