/**
 * Files API Tests — /api/files
 *
 * Tests: list, read, write, mkdir, delete, rename, path traversal protection.
 * Uses a temporary workspace directory so tests never touch the real /workspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

// Mock broadcastStatus (called by mkdir, delete, rename)
const { mockBroadcastStatus } = vi.hoisted(() => ({
  mockBroadcastStatus: vi.fn(),
}));

vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

// WORKSPACE is set in tests/setup.ts to /tmp/codeck-test/workspace
const TEST_WORKSPACE = process.env.WORKSPACE!;

import filesRouter from '../../apps/runtime/src/routes/files.routes.js';

describe('Files API', () => {
  let app: Express;

  beforeEach(() => {
    // Clean workspace contents (not the dir itself — setup.ts creates it)
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    mkdirSync(TEST_WORKSPACE, { recursive: true });

    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/files', filesRouter);

    vi.clearAllMocks();
  });

  // ── GET /api/files (list directory) ──

  describe('GET /api/files', () => {
    it('should list root directory contents', async () => {
      writeFileSync(join(TEST_WORKSPACE, 'hello.txt'), 'world');
      mkdirSync(join(TEST_WORKSPACE, 'subdir'));

      const res = await request(app).get('/api/files').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.items).toHaveLength(2);
      // Directories come first
      expect(res.body.items[0].name).toBe('subdir');
      expect(res.body.items[0].isDirectory).toBe(true);
      expect(res.body.items[1].name).toBe('hello.txt');
      expect(res.body.items[1].isDirectory).toBe(false);
    });

    it('should list subdirectory contents', async () => {
      mkdirSync(join(TEST_WORKSPACE, 'mydir'));
      writeFileSync(join(TEST_WORKSPACE, 'mydir', 'file.js'), 'code');

      const res = await request(app).get('/api/files?path=mydir').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe('file.js');
    });

    it('should exclude hidden files (dotfiles)', async () => {
      writeFileSync(join(TEST_WORKSPACE, '.hidden'), 'secret');
      writeFileSync(join(TEST_WORKSPACE, 'visible.txt'), 'hi');

      const res = await request(app).get('/api/files').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe('visible.txt');
    });

    it('should return 404 for nonexistent directory', async () => {
      await request(app).get('/api/files?path=nonexistent').expect(404);
    });

    it('should return 403 for path traversal attempt', async () => {
      await request(app).get('/api/files?path=../../etc').expect(403);
    });
  });

  // ── GET /api/files/read ──

  describe('GET /api/files/read', () => {
    it('should read a file', async () => {
      writeFileSync(join(TEST_WORKSPACE, 'readme.md'), '# Hello');

      const res = await request(app).get('/api/files/read?path=readme.md').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.content).toBe('# Hello');
      expect(res.body.size).toBe(7);
    });

    it('should return 400 when path is missing', async () => {
      await request(app).get('/api/files/read').expect(400);
    });

    it('should return 404 for nonexistent file', async () => {
      await request(app).get('/api/files/read?path=nope.txt').expect(404);
    });

    it('should reject files larger than 100KB', async () => {
      const bigContent = 'x'.repeat(101 * 1024);
      writeFileSync(join(TEST_WORKSPACE, 'big.txt'), bigContent);

      const res = await request(app).get('/api/files/read?path=big.txt').expect(200);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('too large');
    });

    it('should return 403 for path traversal', async () => {
      await request(app).get('/api/files/read?path=../../etc/passwd').expect(403);
    });

    it('should return 403 for ../ in middle of path', async () => {
      await request(app).get('/api/files/read?path=subdir/../../etc/passwd').expect(403);
    });
  });

  // ── PUT /api/files/write ──

  describe('PUT /api/files/write', () => {
    it('should write a file', async () => {
      const res = await request(app)
        .put('/api/files/write')
        .send({ path: 'newfile.txt', content: 'hello world' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(readFileSync(join(TEST_WORKSPACE, 'newfile.txt'), 'utf-8')).toBe('hello world');
    });

    it('should return 400 when path is missing', async () => {
      await request(app)
        .put('/api/files/write')
        .send({ content: 'data' })
        .expect(400);
    });

    it('should return 400 when content is missing', async () => {
      await request(app)
        .put('/api/files/write')
        .send({ path: 'file.txt' })
        .expect(400);
    });

    it('should return 400 when content exceeds 500KB', async () => {
      const bigContent = 'x'.repeat(501 * 1024);

      await request(app)
        .put('/api/files/write')
        .send({ path: 'big.txt', content: bigContent })
        .expect(400);
    });

    it('should return 404 when parent directory does not exist', async () => {
      await request(app)
        .put('/api/files/write')
        .send({ path: 'nonexistent/subdir/file.txt', content: 'data' })
        .expect(404);
    });

    it('should return 403 for path traversal', async () => {
      await request(app)
        .put('/api/files/write')
        .send({ path: '../../etc/evil', content: 'pwned' })
        .expect(403);
    });
  });

  // ── POST /api/files/mkdir ──

  describe('POST /api/files/mkdir', () => {
    it('should create a directory', async () => {
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ name: 'my-project' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.name).toBe('my-project');
      expect(existsSync(join(TEST_WORKSPACE, 'my-project'))).toBe(true);
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return 409 when directory already exists', async () => {
      mkdirSync(join(TEST_WORKSPACE, 'existing'));

      await request(app)
        .post('/api/files/mkdir')
        .send({ name: 'existing' })
        .expect(409);
    });

    it('should return 400 for empty name', async () => {
      await request(app)
        .post('/api/files/mkdir')
        .send({ name: '' })
        .expect(400);
    });

    it('should return 400 for missing name', async () => {
      await request(app)
        .post('/api/files/mkdir')
        .send({})
        .expect(400);
    });

    it('should sanitize special characters from name', async () => {
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ name: 'my<project>!@#' })
        .expect(200);

      // Special chars stripped, only alphanumeric/dash/underscore/dot/space remain
      expect(res.body.name).toBe('myproject');
    });

    it('should strip leading dots from name', async () => {
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ name: '..hidden' })
        .expect(200);

      expect(res.body.name).toBe('hidden');
    });

    it('should return 400 for name that sanitizes to empty', async () => {
      await request(app)
        .post('/api/files/mkdir')
        .send({ name: '!@#$%^&*()' })
        .expect(400);
    });
  });

  // ── DELETE /api/files/delete ──

  describe('DELETE /api/files/delete', () => {
    it('should delete a file', async () => {
      writeFileSync(join(TEST_WORKSPACE, 'deleteme.txt'), 'bye');

      const res = await request(app)
        .delete('/api/files/delete')
        .send({ path: 'deleteme.txt' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(existsSync(join(TEST_WORKSPACE, 'deleteme.txt'))).toBe(false);
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should delete an empty directory', async () => {
      mkdirSync(join(TEST_WORKSPACE, 'emptydir'));

      await request(app)
        .delete('/api/files/delete')
        .send({ path: 'emptydir' })
        .expect(200);

      expect(existsSync(join(TEST_WORKSPACE, 'emptydir'))).toBe(false);
    });

    it('should return 409 for non-empty directory', async () => {
      mkdirSync(join(TEST_WORKSPACE, 'fulldir'));
      writeFileSync(join(TEST_WORKSPACE, 'fulldir', 'file.txt'), 'data');

      await request(app)
        .delete('/api/files/delete')
        .send({ path: 'fulldir' })
        .expect(409);
    });

    it('should return 404 for nonexistent file', async () => {
      await request(app)
        .delete('/api/files/delete')
        .send({ path: 'nope.txt' })
        .expect(404);
    });

    it('should return 403 when trying to delete workspace root', async () => {
      await request(app)
        .delete('/api/files/delete')
        .send({ path: '.' })
        .expect(403);
    });

    it('should return 400 when path is missing', async () => {
      await request(app)
        .delete('/api/files/delete')
        .send({})
        .expect(400);
    });

    it('should return 403 for path traversal', async () => {
      await request(app)
        .delete('/api/files/delete')
        .send({ path: '../../etc/passwd' })
        .expect(403);
    });
  });

  // ── POST /api/files/rename ──

  describe('POST /api/files/rename', () => {
    it('should rename a file', async () => {
      writeFileSync(join(TEST_WORKSPACE, 'old.txt'), 'content');

      const res = await request(app)
        .post('/api/files/rename')
        .send({ oldPath: 'old.txt', newPath: 'new.txt' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(existsSync(join(TEST_WORKSPACE, 'old.txt'))).toBe(false);
      expect(readFileSync(join(TEST_WORKSPACE, 'new.txt'), 'utf-8')).toBe('content');
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return 400 when oldPath is missing', async () => {
      await request(app)
        .post('/api/files/rename')
        .send({ newPath: 'new.txt' })
        .expect(400);
    });

    it('should return 400 when newPath is missing', async () => {
      await request(app)
        .post('/api/files/rename')
        .send({ oldPath: 'old.txt' })
        .expect(400);
    });

    it('should return 404 when source does not exist', async () => {
      await request(app)
        .post('/api/files/rename')
        .send({ oldPath: 'nope.txt', newPath: 'new.txt' })
        .expect(404);
    });

    it('should return 403 for path traversal in oldPath', async () => {
      await request(app)
        .post('/api/files/rename')
        .send({ oldPath: '../../etc/passwd', newPath: 'stolen.txt' })
        .expect(403);
    });

    it('should return 403 for path traversal in newPath', async () => {
      writeFileSync(join(TEST_WORKSPACE, 'legit.txt'), 'data');

      await request(app)
        .post('/api/files/rename')
        .send({ oldPath: 'legit.txt', newPath: '../../etc/evil' })
        .expect(403);
    });
  });
});
