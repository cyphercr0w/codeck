/**
 * Tests for POST /api/claude/login - OAuth PKCE initiation
 *
 * This test verifies that the Claude OAuth login endpoint:
 * 1. Initiates the PKCE flow by calling startClaudeLogin()
 * 2. Returns a started response when no login is in progress
 * 3. Returns an in-progress response when login is already active
 * 4. Broadcasts WebSocket status updates
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
  startClaudeLogin: vi.fn((options) => {
    // Simulate async behavior
    setImmediate(() => {
      options?.onUrl?.('https://claude.ai/oauth/authorize?code=true&client_id=test');
    });
    return Promise.resolve({
      started: true,
      message: 'Login started',
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
    });
  }),
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

describe('POST /api/claude/login - PKCE initiation', () => {
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

  it('should initiate OAuth PKCE flow when no login is in progress', async () => {
    const { getLoginState, startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

    // Mock: no login in progress
    vi.mocked(getLoginState).mockReturnValue({
      active: false,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: 0,
    });

    const response = await request(app)
      .post('/api/claude/login')
      .expect(200);

    // Verify response
    expect(response.body).toEqual({
      started: true,
      message: 'Login started',
    });

    // Verify startClaudeLogin was called
    expect(startClaudeLogin).toHaveBeenCalledWith({
      onUrl: expect.any(Function),
      onSuccess: expect.any(Function),
      onError: expect.any(Function),
    });

    // Verify getLoginState was checked first
    expect(getLoginState).toHaveBeenCalled();
  });

  it('should return in-progress status when login is already active with URL', async () => {
    const { getLoginState, startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

    // Mock: login already in progress
    vi.mocked(getLoginState).mockReturnValue({
      active: true,
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
      error: null,
      waitingForCode: true,
      startedAt: Date.now(),
    });

    const response = await request(app)
      .post('/api/claude/login')
      .expect(200);

    // Verify response shows in-progress state
    expect(response.body).toEqual({
      started: false,
      inProgress: true,
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=test',
      waitingForCode: true,
      message: 'Login in progress, waiting for code',
    });

    // Verify startClaudeLogin was NOT called (login already active)
    expect(startClaudeLogin).not.toHaveBeenCalled();
  });

  it('should return in-progress status when login is active but URL not yet generated', async () => {
    const { getLoginState, startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

    // Mock: login active but URL not ready yet
    vi.mocked(getLoginState).mockReturnValue({
      active: true,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: Date.now(),
    });

    const response = await request(app)
      .post('/api/claude/login')
      .expect(200);

    // Verify response shows waiting for URL
    expect(response.body).toEqual({
      started: false,
      inProgress: true,
      url: null,
      waitingForCode: false,
      message: 'Login in progress, waiting for URL...',
    });

    // Verify startClaudeLogin was NOT called
    expect(startClaudeLogin).not.toHaveBeenCalled();
  });

  it('should call broadcastStatus when onUrl callback is triggered', async () => {
    const { getLoginState, startClaudeLogin } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // Mock: no login in progress
    vi.mocked(getLoginState).mockReturnValue({
      active: false,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: 0,
    });

    // Capture the onUrl callback
    let onUrlCallback: ((url: string) => void) | undefined;
    vi.mocked(startClaudeLogin).mockImplementation((options) => {
      onUrlCallback = options?.onUrl;
      return Promise.resolve({
        started: true,
        message: 'Login started',
        url: 'https://claude.ai/oauth/authorize?test',
      });
    });

    await request(app)
      .post('/api/claude/login')
      .expect(200);

    // Trigger the onUrl callback
    expect(onUrlCallback).toBeDefined();
    onUrlCallback!('https://claude.ai/oauth/authorize?test');

    // Verify broadcastStatus was called
    expect(broadcastStatus).toHaveBeenCalled();
  });

  it('should call broadcastStatus when onSuccess callback is triggered', async () => {
    const { getLoginState, startClaudeLogin, invalidateAuthCache } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // Mock: no login in progress
    vi.mocked(getLoginState).mockReturnValue({
      active: false,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: 0,
    });

    // Capture the onSuccess callback
    let onSuccessCallback: (() => void) | undefined;
    vi.mocked(startClaudeLogin).mockImplementation((options) => {
      onSuccessCallback = options?.onSuccess;
      return Promise.resolve({
        started: true,
        message: 'Login started',
      });
    });

    await request(app)
      .post('/api/claude/login')
      .expect(200);

    // Trigger the onSuccess callback
    expect(onSuccessCallback).toBeDefined();
    onSuccessCallback!();

    // Verify both invalidateAuthCache and broadcastStatus were called
    expect(invalidateAuthCache).toHaveBeenCalled();
    expect(broadcastStatus).toHaveBeenCalled();
  });

  it('should call broadcastStatus when onError callback is triggered', async () => {
    const { getLoginState, startClaudeLogin } = await import('../../src/services/auth-anthropic.js');
    const { broadcastStatus } = await import('../../src/web/websocket.js');

    // Mock: no login in progress
    vi.mocked(getLoginState).mockReturnValue({
      active: false,
      url: null,
      error: null,
      waitingForCode: false,
      startedAt: 0,
    });

    // Capture the onError callback
    let onErrorCallback: (() => void) | undefined;
    vi.mocked(startClaudeLogin).mockImplementation((options) => {
      onErrorCallback = options?.onError;
      return Promise.resolve({
        started: true,
        message: 'Login started',
      });
    });

    await request(app)
      .post('/api/claude/login')
      .expect(200);

    // Trigger the onError callback
    expect(onErrorCallback).toBeDefined();
    onErrorCallback!();

    // Verify broadcastStatus was called
    expect(broadcastStatus).toHaveBeenCalled();
  });
});
