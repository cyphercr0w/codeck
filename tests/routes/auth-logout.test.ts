/**
 * POST /api/auth/logout Tests (server.ts:231-235)
 *
 * Tests the logout endpoint that invalidates session tokens
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

// Use default CODECK_DIR (/workspace/.codeck) for testing
const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const AUTH_FILE = join(CODECK_DIR, 'auth.json');
const SESSIONS_FILE = join(CODECK_DIR, 'sessions.json');

describe('POST /api/auth/logout', () => {
  let app: Express;

  beforeEach(async () => {
    // Clean up auth files before each test
    if (existsSync(AUTH_FILE)) {
      rmSync(AUTH_FILE, { force: true });
    }
    if (existsSync(SESSIONS_FILE)) {
      rmSync(SESSIONS_FILE, { force: true });
    }

    // Create a minimal Express app that mimics server.ts structure
    app = express();
    app.use(express.json());

    // Import auth functions dynamically to use test directory
    const { isPasswordConfigured, setupPassword, validatePassword, validateSession, invalidateSession, _resetForTesting } = await import('../../src/services/auth.js');

    // Reset in-memory auth state to match cleaned-up files
    _resetForTesting();

    // PUBLIC endpoints
    app.post('/api/auth/setup', async (req, res) => {
      if (isPasswordConfigured()) {
        res.status(400).json({ error: 'Password already configured' });
        return;
      }
      const { password } = req.body;
      if (!password || password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' });
        return;
      }
      const result = await setupPassword(password);
      res.json(result); // Returns { success: true, token: string }
    });

    app.post('/api/auth/login', async (req, res) => {
      const { password } = req.body;
      const token = await validatePassword(password);
      if (!token) {
        res.status(401).json({ error: 'Incorrect password' });
        return;
      }
      res.json({ token });
    });

    // Auth middleware (server.ts:222-228) - protects all routes below
    app.use((req, res, next) => {
      if (!isPasswordConfigured()) { next(); return; }
      const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string | undefined);
      if (!token || !validateSession(token)) { res.status(401).json({ error: 'Unauthorized', needsAuth: true }); return; }
      next();
    });

    // PROTECTED endpoint: logout (server.ts:231-235)
    app.post('/api/auth/logout', (req, res) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) invalidateSession(token);
      res.json({ success: true });
    });

    // Protected test endpoint
    app.get('/api/status', (_req, res) => {
      res.json({ status: 'ok' });
    });
  });

  afterEach(() => {
    // Clean up auth files after each test
    if (existsSync(AUTH_FILE)) {
      rmSync(AUTH_FILE, { force: true });
    }
    if (existsSync(SESSIONS_FILE)) {
      rmSync(SESSIONS_FILE, { force: true });
    }
  });

  it('should invalidate session token on logout', async () => {
    // Setup: create password and login to get a valid session token
    const setupRes = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'password123' });
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.success).toBe(true);
    expect(setupRes.body.token).toBeDefined();
    const token = setupRes.body.token;
    expect(typeof token).toBe('string');
    expect(token.length).toBe(64); // 64-char hex token

    // Verify token is valid BEFORE logout
    const beforeLogout = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${token}`);
    expect(beforeLogout.status).toBe(200);
    expect(beforeLogout.body.status).toBe('ok');

    // Act: logout with valid token
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    // Assert: logout succeeds
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Verify token is INVALID after logout
    const afterLogout = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${token}`);
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error).toBe('Unauthorized');
    expect(afterLogout.body.needsAuth).toBe(true);
  });
});
