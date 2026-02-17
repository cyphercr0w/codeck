/**
 * Tests for GET /api/claude/login-status - OAuth polling endpoint
 *
 * This test verifies that the login status endpoint:
 * 1. Returns correct status when no login is in progress
 * 2. Returns in-progress status when login is active
 * 3. Returns URL when available during active login
 * 4. Returns error state when login fails
 * 5. Reports authenticated=false during active login (prevents stale cache)
 * 6. Reports authenticated=true only when login is complete
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

describe('GET /api/claude/login-status - OAuth polling', () => {
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

  it('should return authenticated status when no login is in progress', async () => {
    const { getLoginState, getClaudeStatus } = await import('../../src/services/auth-anthropic.js');

    // Mock: no login in progress, user is authenticated
    vi.mocked(getLoginState).mockReturnValue({
      active: false,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: 0,
    });

    vi.mocked(getClaudeStatus).mockReturnValue({
      installed: true,
      authenticated: true, // User is authenticated
      configPath: '/test/.claude',
      loginState: { active: false, url: null, error: null, waitingForCode: false, startedAt: 0 },
      accountInfo: { email: 'test@example.com', name: 'Test User' },
    });

    const response = await request(app)
      .get('/api/claude/login-status')
      .expect(200);

    // Verify response shows not in progress and authenticated
    expect(response.body).toEqual({
      inProgress: false,
      url: null,
      error: null,
      authenticated: true,
    });

    // Verify both state checks were called
    expect(getLoginState).toHaveBeenCalled();
    expect(getClaudeStatus).toHaveBeenCalled();
  });

  it('should return in-progress status when login is active with URL', async () => {
    const { getLoginState, getClaudeStatus } = await import('../../src/services/auth-anthropic.js');

    // Mock: login in progress with URL
    vi.mocked(getLoginState).mockReturnValue({
      active: true,
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
      error: null,
      waitingForCode: true,
      startedAt: Date.now(),
    });

    // Even if user was previously authenticated, report false during active login
    vi.mocked(getClaudeStatus).mockReturnValue({
      installed: true,
      authenticated: true, // Stale cache
      configPath: '/test/.claude',
      loginState: { active: true, url: 'https://claude.ai/oauth/authorize?code=true&client_id=test', error: null, waitingForCode: true, startedAt: Date.now() },
      accountInfo: { email: 'old@example.com', name: 'Old User' },
    });

    const response = await request(app)
      .get('/api/claude/login-status')
      .expect(200);

    // Verify response shows in-progress with URL, authenticated=false
    expect(response.body).toEqual({
      inProgress: true,
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
      error: null,
      authenticated: false, // Should be false during active login
    });

    // Verify getLoginState was called
    expect(getLoginState).toHaveBeenCalled();

    // getClaudeStatus should NOT be called when login is active
    expect(getClaudeStatus).not.toHaveBeenCalled();
  });

  it('should return in-progress status when login is active but URL not yet generated', async () => {
    const { getLoginState } = await import('../../src/services/auth-anthropic.js');

    // Mock: login active but URL not ready yet
    vi.mocked(getLoginState).mockReturnValue({
      active: true,
      url: null, // URL not yet generated
      error: null,
      waitingForCode: false,
      startedAt: Date.now(),
    });

    const response = await request(app)
      .get('/api/claude/login-status')
      .expect(200);

    // Verify response shows in-progress without URL
    expect(response.body).toEqual({
      inProgress: true,
      url: null,
      error: null,
      authenticated: false,
    });
  });

  it('should return error state when login fails', async () => {
    const { getLoginState } = await import('../../src/services/auth-anthropic.js');

    // Mock: login failed
    vi.mocked(getLoginState).mockReturnValue({
      active: true,
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
      error: 'OAuth exchange failed: Invalid authorization code',
      waitingForCode: false,
      startedAt: Date.now() - 60000, // Started 1 minute ago
    });

    const response = await request(app)
      .get('/api/claude/login-status')
      .expect(200);

    // Verify response shows error
    expect(response.body).toEqual({
      inProgress: true,
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
      error: 'OAuth exchange failed: Invalid authorization code',
      authenticated: false,
    });
  });

  it('should not check authenticated status during active login to prevent stale cache', async () => {
    const { getLoginState, getClaudeStatus } = await import('../../src/services/auth-anthropic.js');

    // Mock: login in progress
    vi.mocked(getLoginState).mockReturnValue({
      active: true,
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
      error: null,
      waitingForCode: true,
      startedAt: Date.now(),
    });

    await request(app)
      .get('/api/claude/login-status')
      .expect(200);

    // CRITICAL: getClaudeStatus should NOT be called during active login
    // This prevents the modal from auto-closing before the user submits the code
    expect(getClaudeStatus).not.toHaveBeenCalled();
  });

  it('should return unauthenticated status when no login is in progress and user not authenticated', async () => {
    const { getLoginState, getClaudeStatus } = await import('../../src/services/auth-anthropic.js');

    // Mock: no login in progress, user is NOT authenticated
    vi.mocked(getLoginState).mockReturnValue({
      active: false,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: 0,
    });

    vi.mocked(getClaudeStatus).mockReturnValue({
      installed: true,
      authenticated: false, // User not authenticated
      configPath: '/test/.claude',
      loginState: { active: false, url: null, error: null, waitingForCode: false, startedAt: 0 },
      accountInfo: null,
    });

    const response = await request(app)
      .get('/api/claude/login-status')
      .expect(200);

    // Verify response shows not authenticated
    expect(response.body).toEqual({
      inProgress: false,
      url: null,
      error: null,
      authenticated: false,
    });
  });
});
