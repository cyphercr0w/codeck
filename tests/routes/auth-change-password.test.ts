/**
 * POST /api/auth/change-password route tests
 *
 * Tests server.ts:238-245 password change endpoint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import {
  setupPassword,
  validatePassword,
  changePassword,
  isPasswordConfigured,
  validateSession,
  _resetForTesting
} from '../../src/services/auth.js';

// Use default CODECK_DIR (/workspace/.codeck) for testing
const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const AUTH_FILE = join(CODECK_DIR, 'auth.json');
const SESSIONS_FILE = join(CODECK_DIR, 'sessions.json');

describe('POST /api/auth/change-password', () => {
  let app: Express;

  beforeEach(async () => {
    // Clean up auth files before each test
    if (existsSync(AUTH_FILE)) {
      rmSync(AUTH_FILE, { force: true });
    }
    if (existsSync(SESSIONS_FILE)) {
      rmSync(SESSIONS_FILE, { force: true });
    }
    _resetForTesting();

    // Create Express app that mimics server.ts structure
    app = express();
    app.use(express.json());

    // Public endpoints (no auth required)
    app.get('/api/auth/status', (_req, res) => {
      res.json({ configured: isPasswordConfigured() });
    });

    // Auth middleware (server.ts:222-228)
    app.use((req, res, next) => {
      const publicPaths = ['/api/auth/status', '/api/auth/setup', '/api/auth/login'];
      if (publicPaths.includes(req.path)) return next();
      if (!isPasswordConfigured()) return next();

      const token = (req.headers.authorization?.replace('Bearer ', '')) || (req.query.token as string | undefined);
      if (!token) return res.status(401).json({ error: 'Unauthorized', needsAuth: true });

      if (!validateSession(token)) return res.status(401).json({ error: 'Unauthorized', needsAuth: true });

      next();
    });

    // Protected change-password endpoint (server.ts:238-245)
    app.post('/api/auth/change-password', async (req, res) => {
      const { currentPassword, newPassword } = req.body;
      if (!newPassword || newPassword.length < 8) {
        res.status(400).json({ error: 'New password must be at least 8 characters' });
        return;
      }
      if (newPassword.length > 256) {
        res.status(400).json({ error: 'New password must not exceed 256 characters' });
        return;
      }
      const result = await changePassword(currentPassword, newPassword);
      if (result.success) res.json({ success: true, token: result.token });
      else res.status(401).json({ success: false, error: result.error });
    });
  });

  afterEach(async () => {
    // Clean up auth files after each test
    if (existsSync(AUTH_FILE)) {
      rmSync(AUTH_FILE, { force: true });
    }
    if (existsSync(SESSIONS_FILE)) {
      rmSync(SESSIONS_FILE, { force: true });
    }
  });

  it('should verify current password before allowing change', async () => {
    // Setup: Create initial password
    const currentPassword = 'current-password-123';
    const newPassword = 'new-password-456';
    const setupResult = await setupPassword(currentPassword);
    expect(setupResult.success).toBe(true);
    expect(setupResult.token).toBeDefined();
    const token = setupResult.token!;

    // Act: Attempt to change password with correct current password
    const response = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword, newPassword });

    // Assert: Password change should succeed
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.token).toBeDefined();
    expect(response.body.token).toMatch(/^[a-f0-9]{64}$/); // 64-char hex

    // Verify: New password works for login
    const newPasswordResult = await validatePassword(newPassword);
    expect(newPasswordResult.success).toBe(true);

    // Verify: Old password no longer works
    const oldPasswordResult = await validatePassword(currentPassword);
    expect(oldPasswordResult.success).toBe(false);

    // Verify: New session token is returned and valid
    expect(validateSession(response.body.token)).toBe(true);
  });

  it('should reject incorrect current password', async () => {
    // Setup: Create initial password
    const currentPassword = 'correct-password-123';
    const wrongPassword = 'wrong-password-456';
    const newPassword = 'new-password-789';
    const setupResult = await setupPassword(currentPassword);
    expect(setupResult.success).toBe(true);
    expect(setupResult.token).toBeDefined();
    const token = setupResult.token!;

    // Act: Attempt to change password with INCORRECT current password
    const response = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: wrongPassword, newPassword });

    // Assert: Password change should fail with 401
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Current password is incorrect');
    expect(response.body.token).toBeUndefined();

    // Verify: Password was NOT changed (old password still works)
    const oldPasswordResult = await validatePassword(currentPassword);
    expect(oldPasswordResult.success).toBe(true);

    // Verify: New password does NOT work (change was rejected)
    const newPasswordResult = await validatePassword(newPassword);
    expect(newPasswordResult.success).toBe(false);
  });
});
