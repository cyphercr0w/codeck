/**
 * tests/routes/cli-auth.test.ts
 *
 * Tests for CLI auth routes:
 *   GET  /api/cli-auth/supported          — list supported services
 *   POST /api/cli-auth/:service/login     — start device flow login
 *   GET  /api/cli-auth/:service/status    — poll auth status
 *   POST /api/cli-auth/:service/cancel    — cancel in-progress login
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockStartCLIAuth,
  mockGetAuthState,
  mockCancelCLIAuth,
  mockGetSupportedCLIAuthServices,
  mockIsValidService,
  mockBroadcastStatus,
} = vi.hoisted(() => ({
  mockStartCLIAuth: vi.fn(),
  mockGetAuthState: vi.fn(),
  mockCancelCLIAuth: vi.fn(),
  mockGetSupportedCLIAuthServices: vi.fn(),
  mockIsValidService: vi.fn(),
  mockBroadcastStatus: vi.fn(),
}));

// Mock dependencies before importing router
vi.mock('../../apps/runtime/src/services/cli-auth.js', () => ({
  startCLIAuth: mockStartCLIAuth,
  getAuthState: mockGetAuthState,
  cancelCLIAuth: mockCancelCLIAuth,
  getSupportedCLIAuthServices: mockGetSupportedCLIAuthServices,
  isValidService: mockIsValidService,
}));

vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

// Import router after mocks
import cliAuthRouter from '../../apps/runtime/src/routes/cli-auth.routes.js';

describe('CLI Auth Routes', () => {
  let app: Express;

  const defaultAuthState = {
    inProgress: false,
    code: null as string | null,
    url: null as string | null,
    success: false,
    error: null as string | null,
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cli-auth', cliAuthRouter);

    vi.clearAllMocks();

    // Default behaviors
    mockGetSupportedCLIAuthServices.mockReturnValue(['vercel']);
    mockIsValidService.mockImplementation((service: string) => service === 'vercel');
    mockStartCLIAuth.mockReturnValue({ ...defaultAuthState, inProgress: true });
    mockGetAuthState.mockReturnValue({ ...defaultAuthState });
    mockCancelCLIAuth.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /supported ────────────────────────────────────────────────

  describe('GET /supported', () => {
    it('should return list of supported services', async () => {
      mockGetSupportedCLIAuthServices.mockReturnValue(['vercel']);

      const response = await request(app)
        .get('/api/cli-auth/supported');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ services: ['vercel'] });
      expect(mockGetSupportedCLIAuthServices).toHaveBeenCalledOnce();
    });

    it('should return empty array when no services configured', async () => {
      mockGetSupportedCLIAuthServices.mockReturnValue([]);

      const response = await request(app)
        .get('/api/cli-auth/supported');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ services: [] });
    });

    it('should return multiple services', async () => {
      mockGetSupportedCLIAuthServices.mockReturnValue(['vercel', 'netlify', 'fly']);

      const response = await request(app)
        .get('/api/cli-auth/supported');

      expect(response.status).toBe(200);
      expect(response.body.services).toHaveLength(3);
      expect(response.body.services).toEqual(['vercel', 'netlify', 'fly']);
    });
  });

  // ── POST /:service/login ──────────────────────────────────────────

  describe('POST /:service/login', () => {
    it('should start login for a valid service', async () => {
      const authState = { inProgress: true, code: null, url: null, success: false, error: null };
      mockStartCLIAuth.mockReturnValue(authState);

      const response = await request(app)
        .post('/api/cli-auth/vercel/login');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(authState);
      expect(mockStartCLIAuth).toHaveBeenCalledOnce();
      expect(mockStartCLIAuth).toHaveBeenCalledWith('vercel', expect.any(Function));
    });

    it('should return 400 for unsupported service', async () => {
      mockIsValidService.mockReturnValue(false);

      const response = await request(app)
        .post('/api/cli-auth/unsupported/login');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Unsupported service');
      expect(mockStartCLIAuth).not.toHaveBeenCalled();
    });

    it('should pass broadcastStatus as onUpdate callback', async () => {
      mockStartCLIAuth.mockImplementation((service: string, onUpdate: Function) => {
        // Simulate calling the callback
        onUpdate();
        return { inProgress: true, code: null, url: null, success: false, error: null };
      });

      await request(app)
        .post('/api/cli-auth/vercel/login');

      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return existing state when login already in progress', async () => {
      const existingState = {
        inProgress: true,
        code: 'ABCD-1234',
        url: 'https://vercel.com/oauth/device',
        success: false,
        error: null,
      };
      mockStartCLIAuth.mockReturnValue(existingState);

      const response = await request(app)
        .post('/api/cli-auth/vercel/login');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(existingState);
    });

    it('should reject service names with path traversal', async () => {
      mockIsValidService.mockReturnValue(false);

      const response = await request(app)
        .post('/api/cli-auth/..%2F..%2Fetc/login');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Unsupported service');
    });
  });

  // ── GET /:service/status ──────────────────────────────────────────

  describe('GET /:service/status', () => {
    it('should return auth state for a valid service', async () => {
      const authState = {
        inProgress: true,
        code: 'XYZ-789',
        url: 'https://vercel.com/oauth/device?code=XYZ-789',
        success: false,
        error: null,
      };
      mockGetAuthState.mockReturnValue(authState);

      const response = await request(app)
        .get('/api/cli-auth/vercel/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(authState);
      expect(mockGetAuthState).toHaveBeenCalledWith('vercel');
    });

    it('should return 400 for unsupported service', async () => {
      mockIsValidService.mockReturnValue(false);

      const response = await request(app)
        .get('/api/cli-auth/invalid/status');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Unsupported service');
      expect(mockGetAuthState).not.toHaveBeenCalled();
    });

    it('should return default state when no login has been started', async () => {
      mockGetAuthState.mockReturnValue({
        inProgress: false,
        code: null,
        url: null,
        success: false,
        error: null,
      });

      const response = await request(app)
        .get('/api/cli-auth/vercel/status');

      expect(response.status).toBe(200);
      expect(response.body.inProgress).toBe(false);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeNull();
    });

    it('should return success state after completed login', async () => {
      mockGetAuthState.mockReturnValue({
        inProgress: false,
        code: null,
        url: null,
        success: true,
        error: null,
      });

      const response = await request(app)
        .get('/api/cli-auth/vercel/status');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.inProgress).toBe(false);
    });

    it('should return error state after failed login', async () => {
      mockGetAuthState.mockReturnValue({
        inProgress: false,
        code: null,
        url: null,
        success: false,
        error: 'Login timed out',
      });

      const response = await request(app)
        .get('/api/cli-auth/vercel/status');

      expect(response.status).toBe(200);
      expect(response.body.error).toBe('Login timed out');
      expect(response.body.success).toBe(false);
    });
  });

  // ── POST /:service/cancel ─────────────────────────────────────────

  describe('POST /:service/cancel', () => {
    it('should cancel login for a valid service', async () => {
      const response = await request(app)
        .post('/api/cli-auth/vercel/cancel');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ cancelled: true });
      expect(mockCancelCLIAuth).toHaveBeenCalledWith('vercel');
    });

    it('should return 400 for unsupported service', async () => {
      mockIsValidService.mockReturnValue(false);

      const response = await request(app)
        .post('/api/cli-auth/fake/cancel');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Unsupported service');
      expect(mockCancelCLIAuth).not.toHaveBeenCalled();
    });

    it('should succeed even when no login is in progress', async () => {
      // cancelCLIAuth is idempotent — no error when nothing to cancel
      mockCancelCLIAuth.mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/cli-auth/vercel/cancel');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ cancelled: true });
    });
  });
});
