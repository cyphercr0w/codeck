/**
 * Permissions API Tests — /api/permissions
 *
 * Tests: read and update permission toggles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Check if permissions routes exist and what they export
import permissionsRouter from '../../apps/runtime/src/routes/permissions.routes.js';

describe('Permissions API', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/permissions', permissionsRouter);
    vi.clearAllMocks();
  });

  describe('GET /api/permissions', () => {
    it('should return permission object with boolean values', async () => {
      const res = await request(app).get('/api/permissions').expect(200);

      // All permission keys should be booleans
      for (const value of Object.values(res.body)) {
        expect(typeof value).toBe('boolean');
      }
    });

    it('should include standard permission keys', async () => {
      const res = await request(app).get('/api/permissions').expect(200);

      // At minimum, these permissions should exist
      const expectedKeys = ['Read', 'Edit', 'Write', 'Bash'];
      for (const key of expectedKeys) {
        expect(res.body).toHaveProperty(key);
      }
    });
  });

  describe('POST /api/permissions', () => {
    it('should update a permission', async () => {
      const res = await request(app)
        .post('/api/permissions')
        .send({ Bash: false })
        .expect(200);

      expect(res.body.Bash).toBe(false);
    });

    it('should return updated permissions object', async () => {
      const res = await request(app)
        .post('/api/permissions')
        .send({ WebFetch: false, WebSearch: false })
        .expect(200);

      expect(res.body.WebFetch).toBe(false);
      expect(res.body.WebSearch).toBe(false);
    });
  });
});
