/**
 * Auth Middleware Tests (server.ts:222-228)
 *
 * Tests the authentication middleware that protects /api/* routes
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

// Use default CODECK_DIR (/workspace/.codeck) for testing
const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const AUTH_FILE = join(CODECK_DIR, 'auth.json');
const SESSIONS_FILE = join(CODECK_DIR, 'sessions.json');

describe('Auth Middleware', () => {
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
    const { isPasswordConfigured, setupPassword, validateSession, _resetForTesting } = await import('../../src/services/auth.js');

    // Reset in-memory auth state to match cleaned-up files
    _resetForTesting();

    // PUBLIC endpoints (before middleware) - these should ALWAYS work without auth
    app.get('/api/auth/status', (_req, res) => {
      res.json({ configured: isPasswordConfigured() });
    });

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
      res.json(result);
    });

    app.post('/api/auth/login', async (req, res) => {
      // Simplified login - just return mock token for testing
      res.json({ success: true, token: 'mock_token_for_testing' });
    });

    // AUTH MIDDLEWARE (server.ts:222-228)
    app.use('/api', (req, res, next) => {
      if (!isPasswordConfigured()) return next();
      // Support token via Bearer header or ?token= query param
      const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string | undefined);
      if (!token || !validateSession(token)) {
        res.status(401).json({ error: 'Unauthorized', needsAuth: true });
        return;
      }
      next();
    });

    // PROTECTED endpoints (after middleware) - these require auth if password is configured
    app.get('/api/status', (_req, res) => {
      res.json({ status: 'ok' });
    });

    app.get('/api/ports', (_req, res) => {
      res.json({ ports: [] });
    });

    app.post('/api/auth/logout', (_req, res) => {
      res.json({ success: true });
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
    vi.restoreAllMocks();
  });

  describe('Public Endpoints (before middleware)', () => {
    it('should allow GET /api/auth/status without token', async () => {
      const response = await request(app)
        .get('/api/auth/status')
        .expect(200);

      expect(response.body).toHaveProperty('configured');
      expect(response.body.configured).toBe(false); // No password configured yet
    });

    it('should allow POST /api/auth/setup without token', async () => {
      const response = await request(app)
        .post('/api/auth/setup')
        .send({ password: 'test_password_123' })
        .expect(200);

      expect(response.body).toHaveProperty('token');
      expect(response.body.token).toMatch(/^[a-f0-9]{64}$/); // 64-char hex token
    });

    it('should allow POST /api/auth/login without token', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ password: 'test_password_123' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('token');
    });

    it('should allow public endpoints even when password is configured', async () => {
      // Setup password first
      await request(app)
        .post('/api/auth/setup')
        .send({ password: 'test_password_123' });

      // Public endpoints should still work without auth
      await request(app)
        .get('/api/auth/status')
        .expect(200);

      await request(app)
        .post('/api/auth/login')
        .send({ password: 'test_password_123' })
        .expect(200);
    });
  });

  describe('Protected Endpoints (after middleware)', () => {
    it('should reject protected endpoints without token when password is configured', async () => {
      // Setup password first
      const setupResponse = await request(app)
        .post('/api/auth/setup')
        .send({ password: 'test_password_123' });

      expect(setupResponse.body).toHaveProperty('token');

      // Now that password is configured, protected endpoints should reject requests without token
      const statusResponse = await request(app)
        .get('/api/status')
        .expect(401);

      expect(statusResponse.body).toEqual({
        error: 'Unauthorized',
        needsAuth: true,
      });

      // Test another protected endpoint
      const portsResponse = await request(app)
        .get('/api/ports')
        .expect(401);

      expect(portsResponse.body).toEqual({
        error: 'Unauthorized',
        needsAuth: true,
      });

      // Test logout endpoint (also protected)
      const logoutResponse = await request(app)
        .post('/api/auth/logout')
        .expect(401);

      expect(logoutResponse.body).toEqual({
        error: 'Unauthorized',
        needsAuth: true,
      });
    });

    it('should accept valid Bearer token in Authorization header', async () => {
      // Setup password first and get valid session token
      const setupResponse = await request(app)
        .post('/api/auth/setup')
        .send({ password: 'test_password_123' });

      const validToken = setupResponse.body.token;
      expect(validToken).toMatch(/^[a-f0-9]{64}$/); // Verify valid token format

      // Now access protected endpoints with valid Bearer token
      const statusResponse = await request(app)
        .get('/api/status')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(statusResponse.body).toEqual({ status: 'ok' });

      // Test another protected endpoint
      const portsResponse = await request(app)
        .get('/api/ports')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(portsResponse.body).toEqual({ ports: [] });

      // Test POST endpoint with Bearer token
      const logoutResponse = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(logoutResponse.body).toEqual({ success: true });
    });

    it('should accept valid ?token= query param', async () => {
      // Setup password first and get valid session token
      const setupResponse = await request(app)
        .post('/api/auth/setup')
        .send({ password: 'test_password_123' });

      const validToken = setupResponse.body.token;
      expect(validToken).toMatch(/^[a-f0-9]{64}$/); // Verify valid token format

      // Now access protected endpoints with ?token= query param
      const statusResponse = await request(app)
        .get(`/api/status?token=${validToken}`)
        .expect(200);

      expect(statusResponse.body).toEqual({ status: 'ok' });

      // Test another protected endpoint
      const portsResponse = await request(app)
        .get(`/api/ports?token=${validToken}`)
        .expect(200);

      expect(portsResponse.body).toEqual({ ports: [] });

      // Test POST endpoint with query param token (less common but should work)
      const logoutResponse = await request(app)
        .post(`/api/auth/logout?token=${validToken}`)
        .expect(200);

      expect(logoutResponse.body).toEqual({ success: true });
    });

    it('should reject expired token (401)', async () => {
      // Setup password first and get valid session token
      const setupResponse = await request(app)
        .post('/api/auth/setup')
        .send({ password: 'test_password_123' });

      const expiredToken = setupResponse.body.token;
      expect(expiredToken).toMatch(/^[a-f0-9]{64}$/); // Verify valid token format

      // Dynamically import auth service to access activeSessions
      const authModule = await import('../../src/services/auth.js');

      // Access the private activeSessions Map via module's memory
      // We need to manipulate the session's createdAt timestamp to make it expired
      const sessionsFile = join(CODECK_DIR, 'sessions.json');
      const sessionsData = JSON.parse(readFileSync(sessionsFile, 'utf-8'));

      // Set createdAt to 8 days ago (SESSION_TTL is 7 days by default)
      const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
      sessionsData[expiredToken].createdAt = eightDaysAgo;

      // Write back the modified sessions file
      const { writeFileSync } = await import('fs');
      writeFileSync(sessionsFile, JSON.stringify(sessionsData, null, 2));

      // Force re-load sessions from disk (by reimporting the module won't work as it's cached)
      // We need to directly manipulate the activeSessions Map
      // Since activeSessions is private, we'll test by making a request which will trigger validateSession
      // which reads from the in-memory Map that we need to update

      // Reload the auth module to pick up the new session timestamp
      // We can do this by calling a function that loads sessions
      // Actually, the module is already loaded, so we need to manually update the Map
      // Let's use a different approach: use vi.mock to control time

      // Alternative: Use fake timers to advance time by 8 days
      vi.useFakeTimers();
      vi.setSystemTime(new Date()); // Set to now

      // Now advance time by 8 days (7 days TTL + 1 day to ensure expiration)
      vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

      // Now try to access protected endpoints with the expired token
      const statusResponse = await request(app)
        .get('/api/status')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(statusResponse.body).toEqual({
        error: 'Unauthorized',
        needsAuth: true,
      });

      // Test with query param as well
      const portsResponse = await request(app)
        .get(`/api/ports?token=${expiredToken}`)
        .expect(401);

      expect(portsResponse.body).toEqual({
        error: 'Unauthorized',
        needsAuth: true,
      });

      vi.useRealTimers();
    });

    it('should reject malformed token (invalid format)', async () => {
      // Setup password first
      await request(app)
        .post('/api/auth/setup')
        .send({ password: 'test_password_123' });

      // Test with various malformed token formats
      const malformedTokens = [
        'not-a-valid-token',           // Wrong format
        '12345',                        // Too short
        'x'.repeat(63),                 // Too short (63 chars instead of 64)
        'x'.repeat(65),                 // Too long (65 chars instead of 64)
        'g'.repeat(64),                 // Invalid hex chars (g is not hex)
        '',                             // Empty string
        'Bearer abc123',                // Double Bearer prefix
        '../../../etc/passwd',          // Path traversal attempt
        '"><script>alert(1)</script>',  // XSS attempt
      ];

      for (const malformedToken of malformedTokens) {
        // Test with Bearer header
        const statusResponse = await request(app)
          .get('/api/status')
          .set('Authorization', `Bearer ${malformedToken}`)
          .expect(401);

        expect(statusResponse.body).toEqual({
          error: 'Unauthorized',
          needsAuth: true,
        });

        // Test with query param
        const portsResponse = await request(app)
          .get('/api/ports')
          .query({ token: malformedToken })
          .expect(401);

        expect(portsResponse.body).toEqual({
          error: 'Unauthorized',
          needsAuth: true,
        });
      }
    });
  });
});
