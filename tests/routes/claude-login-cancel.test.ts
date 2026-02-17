/**
 * Tests for POST /api/claude/login-cancel - OAuth flow cancellation
 *
 * This test verifies that the Claude OAuth login cancellation endpoint:
 * 1. Calls cancelLogin() to clear the login state
 * 2. Broadcasts WebSocket status update
 * 3. Returns success response
 * 4. Is idempotent (safe to call when no login is active)
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

describe('POST /api/claude/login-cancel - OAuth flow cancellation', () => {
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

  it('should cancel active OAuth login and broadcast status', async () => {
    const { cancelLogin } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    const response = await request(app)
      .post('/api/claude/login-cancel')
      .expect(200);

    // Verify response
    expect(response.body).toEqual({
      success: true,
    });

    // Verify cancelLogin was called
    expect(cancelLogin).toHaveBeenCalledOnce();

    // Verify broadcastStatus was called to notify clients
    expect(broadcastStatus).toHaveBeenCalledOnce();
  });

  it('should be idempotent (safe to call when no login is active)', async () => {
    const { cancelLogin } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // First call
    const response1 = await request(app)
      .post('/api/claude/login-cancel')
      .expect(200);

    expect(response1.body).toEqual({ success: true });

    // Second call (no login active)
    const response2 = await request(app)
      .post('/api/claude/login-cancel')
      .expect(200);

    expect(response2.body).toEqual({ success: true });

    // Verify cancelLogin was called both times (idempotent)
    expect(cancelLogin).toHaveBeenCalledTimes(2);
    expect(broadcastStatus).toHaveBeenCalledTimes(2);
  });

  it('should always return 200 with success:true regardless of login state', async () => {
    const { getLoginState } = await import('../../src/services/auth-anthropic.js');

    // Test with login active
    vi.mocked(getLoginState).mockReturnValue({
      active: true,
      url: 'https://claude.ai/oauth/authorize',
      error: null,
      waitingForCode: true,
      startedAt: Date.now(),
    });

    const response1 = await request(app)
      .post('/api/claude/login-cancel')
      .expect(200);

    expect(response1.body).toEqual({ success: true });

    // Test with login not active
    vi.mocked(getLoginState).mockReturnValue({
      active: false,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: 0,
    });

    const response2 = await request(app)
      .post('/api/claude/login-cancel')
      .expect(200);

    expect(response2.body).toEqual({ success: true });
  });

  it('should not require any request body parameters', async () => {
    const { cancelLogin } = await import('../../src/services/auth-anthropic.js');

    // Empty body
    const response = await request(app)
      .post('/api/claude/login-cancel')
      .send({})
      .expect(200);

    expect(response.body).toEqual({ success: true });
    expect(cancelLogin).toHaveBeenCalledOnce();
  });

  it('should call cancelLogin before broadcastStatus (correct order)', async () => {
    const { cancelLogin } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    const callOrder: string[] = [];

    vi.mocked(cancelLogin).mockImplementation(() => {
      callOrder.push('cancelLogin');
    });

    vi.mocked(broadcastStatus).mockImplementation(() => {
      callOrder.push('broadcastStatus');
    });

    await request(app)
      .post('/api/claude/login-cancel')
      .expect(200);

    // Verify order: cancelLogin must be called before broadcastStatus
    expect(callOrder).toEqual(['cancelLogin', 'broadcastStatus']);
  });
});
