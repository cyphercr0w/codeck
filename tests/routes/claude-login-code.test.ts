/**
 * Tests for POST /api/claude/login-code - OAuth code exchange
 *
 * This test verifies that the Claude OAuth code exchange endpoint:
 * 1. Validates that a code is provided in the request body
 * 2. Calls sendLoginCode() to exchange the code for a token
 * 3. Broadcasts WebSocket status updates on success
 * 4. Returns appropriate success/error responses
 * 5. Handles various code formats (plain code, code#state, full URL, direct token)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import agentRoutes from '../../src/routes/agent.routes.js';

// Mock the dependencies
vi.mock('../../src/services/auth-anthropic.js', () => ({
  getClaudeStatus: vi.fn(() => ({
    installed: true,
    authenticated: false,
    configPath: '/test/.claude',
    loginState: { active: false, url: null, error: null, waitingForCode: false, startedAt: 0 },
    accountInfo: null,
  })),
  startClaudeLogin: vi.fn(),
  getLoginState: vi.fn(() => ({
    active: false,
    url: null,
    error: null,
    waitingForCode: false,
    startedAt: 0,
  })),
  invalidateAuthCache: vi.fn(),
  cancelLogin: vi.fn(),
  sendLoginCode: vi.fn(),
}));

vi.mock('../../src/web/websocket.js', () => ({
  broadcastStatus: vi.fn(),
}));

describe('POST /api/claude/login-code - OAuth code exchange', () => {
  let app: express.Express;

  beforeEach(() => {
    // Create fresh Express app for each test
    app = express();
    app.use(express.json());
    app.use('/api/claude', agentRoutes);

    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 400 when code is missing', async () => {
    const response = await request(app)
      .post('/api/claude/login-code')
      .send({})
      .expect(400);

    // Verify error response
    expect(response.body).toEqual({
      success: false,
      error: 'Code required',
    });

    // Verify sendLoginCode was NOT called
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');
    expect(sendLoginCode).not.toHaveBeenCalled();
  });

  it('should return 400 when code is empty string', async () => {
    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: '' })
      .expect(400);

    // Verify error response
    expect(response.body).toEqual({
      success: false,
      error: 'Code required',
    });

    // Verify sendLoginCode was NOT called
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');
    expect(sendLoginCode).not.toHaveBeenCalled();
  });

  it('should successfully exchange authorization code for token', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // Mock successful code exchange
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: true,
    });

    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: 'auth_code_abc123xyz' })
      .expect(200);

    // Verify response
    expect(response.body).toEqual({
      success: true,
    });

    // Verify sendLoginCode was called with the code
    expect(sendLoginCode).toHaveBeenCalledWith('auth_code_abc123xyz');
    expect(sendLoginCode).toHaveBeenCalledTimes(1);

    // Verify broadcastStatus was called on success
    expect(broadcastStatus).toHaveBeenCalled();
  });

  it('should return error when code exchange fails', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // Mock failed code exchange
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: false,
      error: 'Invalid authorization code',
    });

    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: 'invalid_code' })
      .expect(200);

    // Verify error response
    expect(response.body).toEqual({
      success: false,
      error: 'Invalid authorization code',
    });

    // Verify sendLoginCode was called
    expect(sendLoginCode).toHaveBeenCalledWith('invalid_code');

    // Verify broadcastStatus was NOT called on failure
    expect(broadcastStatus).not.toHaveBeenCalled();
  });

  it('should handle direct OAuth token (sk-ant-oat01-...)', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // Mock successful token save
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: true,
    });

    const directToken = 'sk-ant-oat01-abcdef1234567890';

    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: directToken })
      .expect(200);

    // Verify response
    expect(response.body).toEqual({
      success: true,
    });

    // Verify sendLoginCode was called with the token
    expect(sendLoginCode).toHaveBeenCalledWith(directToken);

    // Verify broadcastStatus was called
    expect(broadcastStatus).toHaveBeenCalled();
  });

  it('should handle session expiration error', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');

    // Mock session expired error
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: false,
      error: 'Login session expired. Click "Login" again.',
    });

    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: 'auth_code_123' })
      .expect(200);

    // Verify error response
    expect(response.body).toEqual({
      success: false,
      error: 'Login session expired. Click "Login" again.',
    });

    // Verify sendLoginCode was called
    expect(sendLoginCode).toHaveBeenCalledWith('auth_code_123');
  });

  it('should handle state mismatch (CSRF protection)', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');

    // Mock state mismatch error
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: false,
      error: 'State mismatch — possible CSRF. Login again.',
    });

    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: 'auth_code_123#wrong_state' })
      .expect(200);

    // Verify error response
    expect(response.body).toEqual({
      success: false,
      error: 'State mismatch — possible CSRF. Login again.',
    });

    // Verify sendLoginCode was called
    expect(sendLoginCode).toHaveBeenCalledWith('auth_code_123#wrong_state');
  });

  it('should handle network errors during token exchange', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');

    // Mock network error
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: false,
      error: 'Network error: fetch failed. Login again.',
    });

    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: 'auth_code_123' })
      .expect(200);

    // Verify error response
    expect(response.body).toEqual({
      success: false,
      error: 'Network error: fetch failed. Login again.',
    });

    // Verify sendLoginCode was called
    expect(sendLoginCode).toHaveBeenCalledWith('auth_code_123');
  });

  it('should handle OAuth server errors', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');

    // Mock OAuth server error
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: false,
      error: 'Error exchanging code (400). Login again to get a new code.',
    });

    const response = await request(app)
      .post('/api/claude/login-code')
      .send({ code: 'expired_code' })
      .expect(200);

    // Verify error response
    expect(response.body).toEqual({
      success: false,
      error: 'Error exchanging code (400). Login again to get a new code.',
    });

    // Verify sendLoginCode was called
    expect(sendLoginCode).toHaveBeenCalledWith('expired_code');
  });

  it('should pass the code as-is to sendLoginCode (trimming/parsing handled by service)', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');

    // Mock success
    vi.mocked(sendLoginCode).mockResolvedValue({
      success: true,
    });

    // Test with code that has whitespace and state parameter
    const codeWithExtras = '  auth_code_123#state_xyz  ';

    await request(app)
      .post('/api/claude/login-code')
      .send({ code: codeWithExtras })
      .expect(200);

    // Verify sendLoginCode receives the code as-is (service handles parsing)
    expect(sendLoginCode).toHaveBeenCalledWith(codeWithExtras);
  });

  it('should not broadcast status when code exchange fails', async () => {
    const { sendLoginCode } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // Mock multiple failure scenarios
    const failureScenarios = [
      { success: false, error: 'Invalid code' },
      { success: false, error: 'Session expired' },
      { success: false, error: 'Network error' },
    ];

    for (const failureResult of failureScenarios) {
      vi.clearAllMocks();
      vi.mocked(sendLoginCode).mockResolvedValue(failureResult);

      await request(app)
        .post('/api/claude/login-code')
        .send({ code: 'test_code' })
        .expect(200);

      // Verify broadcastStatus was NOT called on any failure
      expect(broadcastStatus).not.toHaveBeenCalled();
    }
  });
});
