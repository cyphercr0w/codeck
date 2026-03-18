/**
 * Files Upload API Tests — POST /api/files/upload-image
 *
 * Tests image upload endpoint: MIME validation, size limits, empty data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync, existsSync } from 'fs';

// Mock broadcastStatus
vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: vi.fn(),
}));

// WORKSPACE is set in tests/setup.ts
const TEST_WORKSPACE = process.env.WORKSPACE!;

import filesRouter from '../../apps/runtime/src/routes/files.routes.js';

describe('Files Upload API', () => {
  let app: Express;

  beforeEach(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    mkdirSync(TEST_WORKSPACE, { recursive: true });

    app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use('/api/files', filesRouter);

    vi.clearAllMocks();
  });

  describe('POST /api/files/upload-image', () => {
    // A minimal 1x1 white PNG (67 bytes) as base64
    const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    it('should upload a valid PNG image', async () => {
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: TINY_PNG_B64, mimeType: 'image/png', fileName: 'test' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.filePath).toContain('.png');
      expect(existsSync(res.body.filePath)).toBe(true);
    });

    it('should accept JPEG MIME type', async () => {
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: TINY_PNG_B64, mimeType: 'image/jpeg', fileName: 'photo' })
        .expect(200);

      expect(res.body.filePath).toContain('.jpg');
    });

    it('should accept WebP MIME type', async () => {
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: TINY_PNG_B64, mimeType: 'image/webp' })
        .expect(200);

      expect(res.body.filePath).toContain('.webp');
    });

    it('should accept GIF MIME type', async () => {
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: TINY_PNG_B64, mimeType: 'image/gif' })
        .expect(200);

      expect(res.body.filePath).toContain('.gif');
    });

    it('should reject unsupported MIME type', async () => {
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: TINY_PNG_B64, mimeType: 'image/svg+xml' })
        .expect(400);

      expect(res.body.error).toContain('Unsupported image type');
    });

    it('should reject missing data', async () => {
      await request(app)
        .post('/api/files/upload-image')
        .send({ mimeType: 'image/png' })
        .expect(400);
    });

    it('should reject empty base64 data', async () => {
      // Empty buffer after base64 decode
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: '', mimeType: 'image/png' })
        .expect(400);

      expect(res.body.error).toContain('required');
    });

    it('should sanitize special characters in fileName', async () => {
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: TINY_PNG_B64, mimeType: 'image/png', fileName: 'my photo (1).png' })
        .expect(200);

      // Special chars replaced with underscores
      expect(res.body.filePath).not.toContain('(');
      expect(res.body.filePath).not.toContain(')');
      expect(res.body.filePath).not.toContain(' ');
    });

    it('should use "image" as default fileName when not provided', async () => {
      const res = await request(app)
        .post('/api/files/upload-image')
        .send({ data: TINY_PNG_B64, mimeType: 'image/png' })
        .expect(200);

      expect(res.body.filePath).toContain('image');
    });
  });
});
