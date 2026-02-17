import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { setupPassword, isPasswordConfigured, _resetForTesting } from '../../src/services/auth.js';

const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const AUTH_FILE = join(CODECK_DIR, 'auth.json');
const SESSIONS_FILE = join(CODECK_DIR, 'sessions.json');

describe('POST /api/auth/login - Rate Limiting', () => {
  let app: express.Application;
  let request: supertest.SuperTest<supertest.Test>;

  // Shared state between tests (persists across beforeEach)
  const failedAttemptsGlobal = new Map<string, { count: number; lockedUntil: number }>();

  beforeEach(async () => {
    // Clean up any existing auth files
    if (existsSync(AUTH_FILE)) {
      rmSync(AUTH_FILE, { force: true });
    }
    if (existsSync(SESSIONS_FILE)) {
      rmSync(SESSIONS_FILE, { force: true });
    }

    // Reset in-memory auth state to match cleaned-up files
    _resetForTesting();

    // Clear failed attempts state between tests
    failedAttemptsGlobal.clear();

    // Setup password for login tests
    await setupPassword('test-password-123');

    // Create a minimal Express app that mimics server.ts rate limiting logic
    app = express();
    app.set('trust proxy', true); // Enable X-Forwarded-For IP detection
    app.use(express.json());

    // Rate limiting constants (from server.ts:144-145)
    const MAX_FAILED_ATTEMPTS = 5;
    const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

    function checkLockout(ip: string): { locked: boolean; retryAfter?: number } {
      const entry = failedAttemptsGlobal.get(ip);
      if (!entry) return { locked: false };
      // If locked (lockedUntil > 0) and still within lockout period
      if (entry.lockedUntil > 0 && Date.now() < entry.lockedUntil) {
        return { locked: true, retryAfter: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
      }
      // If lockout expired (lockedUntil > 0 but time has passed), delete entry
      if (entry.lockedUntil > 0 && Date.now() >= entry.lockedUntil) {
        failedAttemptsGlobal.delete(ip);
      }
      return { locked: false };
    }

    function recordFailedLogin(ip: string): void {
      const entry = failedAttemptsGlobal.get(ip) || { count: 0, lockedUntil: 0 };
      entry.count++;
      if (entry.count >= MAX_FAILED_ATTEMPTS) {
        entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        entry.count = 0;
      }
      failedAttemptsGlobal.set(ip, entry);
    }

    function clearFailedAttempts(ip: string): void {
      failedAttemptsGlobal.delete(ip);
    }

    // Login endpoint with rate limiting (from server.ts:205-220)
    app.post('/api/auth/login', async (req, res) => {
      const ip = req.ip || 'unknown';
      const lockout = checkLockout(ip);
      if (lockout.locked) {
        res.status(429).json({
          success: false,
          error: 'Too many failed attempts. Try again later.',
          retryAfter: lockout.retryAfter
        });
        return;
      }
      const { validatePassword } = await import('../../src/services/auth.js');
      const result = await validatePassword(req.body.password);
      if (result.success) {
        clearFailedAttempts(ip);
        res.json({ success: true, token: result.token });
      } else {
        recordFailedLogin(ip);
        res.status(401).json({ success: false, error: 'Incorrect password' });
      }
    });

    request = supertest(app);
  });

  afterEach(() => {
    // Clean up after test
    if (existsSync(AUTH_FILE)) {
      rmSync(AUTH_FILE, { force: true });
    }
    if (existsSync(SESSIONS_FILE)) {
      rmSync(SESSIONS_FILE, { force: true });
    }
  });

  it('should allow 5 failed login attempts', async () => {
    // Verify password is configured
    expect(isPasswordConfigured()).toBe(true);

    // Attempt 1: wrong password
    const response1 = await request
      .post('/api/auth/login')
      .send({ password: 'wrong-password-1' });
    expect(response1.status).toBe(401);
    expect(response1.body).toEqual({ success: false, error: 'Incorrect password' });

    // Attempt 2: wrong password
    const response2 = await request
      .post('/api/auth/login')
      .send({ password: 'wrong-password-2' });
    expect(response2.status).toBe(401);
    expect(response2.body).toEqual({ success: false, error: 'Incorrect password' });

    // Attempt 3: wrong password
    const response3 = await request
      .post('/api/auth/login')
      .send({ password: 'wrong-password-3' });
    expect(response3.status).toBe(401);
    expect(response3.body).toEqual({ success: false, error: 'Incorrect password' });

    // Attempt 4: wrong password
    const response4 = await request
      .post('/api/auth/login')
      .send({ password: 'wrong-password-4' });
    expect(response4.status).toBe(401);
    expect(response4.body).toEqual({ success: false, error: 'Incorrect password' });

    // Attempt 5: wrong password (last allowed attempt)
    const response5 = await request
      .post('/api/auth/login')
      .send({ password: 'wrong-password-5' });
    expect(response5.status).toBe(401);
    expect(response5.body).toEqual({ success: false, error: 'Incorrect password' });

    // All 5 attempts should fail but not trigger lockout yet
    // (Lockout happens AFTER 5th failed attempt, on the 6th attempt)
  });

  it('should block 6th failed attempt (429 status)', async () => {
    // Verify password is configured
    expect(isPasswordConfigured()).toBe(true);

    // Perform 5 failed login attempts to reach the threshold
    // Use .set('X-Forwarded-For', '1.2.3.4') to ensure consistent IP tracking
    for (let i = 1; i <= 5; i++) {
      const response = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '1.2.3.4')
        .send({ password: `wrong-password-${i}` });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Incorrect password');
    }

    // Attempt 6: should be locked out (429 Too Many Requests)
    const response6 = await request
      .post('/api/auth/login')
      .set('X-Forwarded-For', '1.2.3.4')
      .send({ password: 'wrong-password-6' });

    expect(response6.status).toBe(429);
    expect(response6.body).toMatchObject({
      success: false,
      error: 'Too many failed attempts. Try again later.'
    });
    expect(response6.body.retryAfter).toBeGreaterThan(0);
    expect(response6.body.retryAfter).toBeLessThanOrEqual(900); // 15 minutes = 900 seconds

    // Attempt 7: should still be locked out (even with correct password)
    const response7 = await request
      .post('/api/auth/login')
      .set('X-Forwarded-For', '1.2.3.4')
      .send({ password: 'test-password-123' }); // Even correct password is blocked

    expect(response7.status).toBe(429);
    expect(response7.body).toMatchObject({
      success: false,
      error: 'Too many failed attempts. Try again later.'
    });
  });

  it('should persist lockout for 15 minutes duration', async () => {
    vi.useFakeTimers();

    try {
      // Verify password is configured
      expect(isPasswordConfigured()).toBe(true);

      // Perform 5 failed login attempts to trigger lockout
      for (let i = 1; i <= 5; i++) {
        const response = await request
          .post('/api/auth/login')
          .set('X-Forwarded-For', '5.6.7.8')
          .send({ password: `wrong-password-${i}` });
        expect(response.status).toBe(401);
      }

      // Attempt 6: should be locked out (429)
      const response6 = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '5.6.7.8')
        .send({ password: 'test-password-123' });

      expect(response6.status).toBe(429);
      expect(response6.body.retryAfter).toBeGreaterThan(0);

      // Advance time by 14 minutes (14 * 60 * 1000 = 840000ms)
      // Should still be locked (lockout is 15 minutes)
      vi.advanceTimersByTime(14 * 60 * 1000);

      const response7 = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '5.6.7.8')
        .send({ password: 'test-password-123' });

      expect(response7.status).toBe(429);
      expect(response7.body).toMatchObject({
        success: false,
        error: 'Too many failed attempts. Try again later.'
      });

      // retryAfter should be approximately 60 seconds (1 minute remaining)
      expect(response7.body.retryAfter).toBeLessThanOrEqual(60);
      expect(response7.body.retryAfter).toBeGreaterThan(0);

      // Advance time by 14.5 minutes total (should still be locked)
      vi.advanceTimersByTime(30 * 1000); // +30 seconds (14.5 min total)

      const response8 = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '5.6.7.8')
        .send({ password: 'test-password-123' });

      expect(response8.status).toBe(429);
      expect(response8.body).toMatchObject({
        success: false,
        error: 'Too many failed attempts. Try again later.'
      });

      // retryAfter should be approximately 30 seconds (30 seconds remaining)
      expect(response8.body.retryAfter).toBeLessThanOrEqual(30);
      expect(response8.body.retryAfter).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should clear lockout after exactly 15 minutes', async () => {
    vi.useFakeTimers();

    try {
      // Verify password is configured
      expect(isPasswordConfigured()).toBe(true);

      // Perform 5 failed login attempts to trigger lockout
      for (let i = 1; i <= 5; i++) {
        const response = await request
          .post('/api/auth/login')
          .set('X-Forwarded-For', '9.10.11.12')
          .send({ password: `wrong-password-${i}` });
        expect(response.status).toBe(401);
      }

      // Attempt 6: should be locked out (429)
      const response6 = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '9.10.11.12')
        .send({ password: 'test-password-123' });

      expect(response6.status).toBe(429);
      expect(response6.body.retryAfter).toBeGreaterThan(0);

      // Advance time by exactly 15 minutes (15 * 60 * 1000 = 900000ms)
      // Should now be unlocked
      vi.advanceTimersByTime(15 * 60 * 1000);

      // Attempt 7: should now be successful with correct password (lockout cleared)
      const response7 = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '9.10.11.12')
        .send({ password: 'test-password-123' });

      expect(response7.status).toBe(200);
      expect(response7.body).toMatchObject({
        success: true
      });
      expect(response7.body.token).toBeDefined();
      expect(response7.body.token).toMatch(/^[a-f0-9]{64}$/); // Valid session token

      // Attempt 8: should allow failed attempts again (counter reset)
      const response8 = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '9.10.11.12')
        .send({ password: 'wrong-password-after-unlock' });

      expect(response8.status).toBe(401);
      expect(response8.body).toMatchObject({
        success: false,
        error: 'Incorrect password'
      });
      // Should NOT be 429 (lockout cleared)
    } finally {
      vi.useRealTimers();
    }
  });

  it('should reset failed attempts counter on successful login', async () => {
    // Verify password is configured
    expect(isPasswordConfigured()).toBe(true);

    // Perform 3 failed login attempts
    for (let i = 1; i <= 3; i++) {
      const response = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '13.14.15.16')
        .send({ password: `wrong-password-${i}` });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Incorrect password');
    }

    // Verify we're at 3 failed attempts (not locked yet, as we need 5 to trigger lockout)
    // Attempt 4: successful login with correct password
    const response4 = await request
      .post('/api/auth/login')
      .set('X-Forwarded-For', '13.14.15.16')
      .send({ password: 'test-password-123' });

    expect(response4.status).toBe(200);
    expect(response4.body).toMatchObject({
      success: true
    });
    expect(response4.body.token).toBeDefined();
    expect(response4.body.token).toMatch(/^[a-f0-9]{64}$/); // Valid session token

    // Now verify counter is reset by performing 5 more failed attempts
    // If counter was NOT reset, we'd only need 2 more attempts (3 + 2 = 5) to trigger lockout
    // But if counter WAS reset, we need 5 new attempts to trigger lockout
    for (let i = 1; i <= 5; i++) {
      const response = await request
        .post('/api/auth/login')
        .set('X-Forwarded-For', '13.14.15.16')
        .send({ password: `wrong-password-after-success-${i}` });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Incorrect password');
    }

    // Attempt 10: 6th failed attempt AFTER reset should trigger lockout (429)
    const response10 = await request
      .post('/api/auth/login')
      .set('X-Forwarded-For', '13.14.15.16')
      .send({ password: 'wrong-password-after-success-6' });

    expect(response10.status).toBe(429);
    expect(response10.body).toMatchObject({
      success: false,
      error: 'Too many failed attempts. Try again later.'
    });
    expect(response10.body.retryAfter).toBeGreaterThan(0);
    expect(response10.body.retryAfter).toBeLessThanOrEqual(900); // 15 minutes = 900 seconds

    // This proves that the successful login reset the counter to 0
    // Otherwise we would have been locked out after attempt 7 (3 + 2 = 5, then 6th would lockout)
  });
});
