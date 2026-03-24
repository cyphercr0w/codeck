/**
 * tests/routes/github.test.ts
 *
 * Tests for GitHub routes:
 *   POST /api/github/login        — start GitHub device flow login
 *   GET  /api/github/login-status  — poll login status
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockGetGitStatus,
  mockStartGitHubFullLogin,
  mockBroadcastStatus,
} = vi.hoisted(() => ({
  mockGetGitStatus: vi.fn(),
  mockStartGitHubFullLogin: vi.fn(),
  mockBroadcastStatus: vi.fn(),
}));

// Mock dependencies before importing router
vi.mock('../../apps/runtime/src/services/git.js', () => ({
  getGitStatus: mockGetGitStatus,
  startGitHubFullLogin: mockStartGitHubFullLogin,
}));

vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

// Import router after mocks — must use dynamic import to reset module state
// between tests since ghLoginState is module-level mutable state.
import githubRouter from '../../apps/runtime/src/routes/github.routes.js';

describe('GitHub Routes', () => {
  let app: Express;

  const defaultGitStatus = {
    installed: true,
    ghInstalled: true,
    ghAuthenticated: false,
    hasGitHubToken: false,
    hasRepository: false,
    workspaceEmpty: true,
    workspace: '/workspace',
    repoName: null,
    repositories: [],
    github: {
      mode: null,
      repoUrl: null,
      authenticated: false,
      username: null,
      email: null,
      avatarUrl: null,
    },
    ssh: {
      hasKey: false,
      authenticated: false,
    },
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/github', githubRouter);

    vi.clearAllMocks();

    // Default behaviors
    mockGetGitStatus.mockReturnValue(defaultGitStatus);
    mockStartGitHubFullLogin.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /login ───────────────────────────────────────────────────

  describe('POST /login', () => {
    it('should start GitHub login and return started: true', async () => {
      // startGitHubFullLogin resolves eventually; the response is sent immediately
      mockStartGitHubFullLogin.mockImplementation(async () => {
        return true;
      });

      const response = await request(app)
        .post('/api/github/login');

      expect(response.status).toBe(200);
      expect(response.body.started).toBe(true);
      expect(response.body.message).toBe('GitHub login started');
      expect(mockStartGitHubFullLogin).toHaveBeenCalledOnce();
    });

    it('should pass callback handlers to startGitHubFullLogin', async () => {
      mockStartGitHubFullLogin.mockImplementation(async (opts: any) => {
        // Verify callbacks exist
        expect(typeof opts.onCode).toBe('function');
        expect(typeof opts.onUrl).toBe('function');
        expect(typeof opts.onSuccess).toBe('function');
        expect(typeof opts.onError).toBe('function');
        return true;
      });

      const response = await request(app)
        .post('/api/github/login');

      expect(response.status).toBe(200);
      expect(response.body.started).toBe(true);
    });

    it('should broadcast status when code is received', async () => {
      mockStartGitHubFullLogin.mockImplementation(async (opts: any) => {
        opts.onCode('ABCD-1234');
        return true;
      });

      await request(app).post('/api/github/login');

      expect(mockBroadcastStatus).toHaveBeenCalled();
    });

    it('should broadcast status when URL is received', async () => {
      mockStartGitHubFullLogin.mockImplementation(async (opts: any) => {
        opts.onUrl('https://github.com/login/device');
        return true;
      });

      await request(app).post('/api/github/login');

      expect(mockBroadcastStatus).toHaveBeenCalled();
    });

    it('should broadcast status on success callback', async () => {
      mockStartGitHubFullLogin.mockImplementation(async (opts: any) => {
        opts.onSuccess();
        return true;
      });

      await request(app).post('/api/github/login');

      expect(mockBroadcastStatus).toHaveBeenCalled();
    });

    it('should broadcast status on error callback', async () => {
      mockStartGitHubFullLogin.mockImplementation(async (opts: any) => {
        opts.onError();
        return false;
      });

      await request(app).post('/api/github/login');

      expect(mockBroadcastStatus).toHaveBeenCalled();
    });
  });

  // ── GET /login-status ─────────────────────────────────────────────

  describe('GET /login-status', () => {
    it('should return login status with git info', async () => {
      const response = await request(app)
        .get('/api/github/login-status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('inProgress');
      expect(response.body).toHaveProperty('code');
      expect(response.body).toHaveProperty('url');
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('authenticated');
      expect(response.body).toHaveProperty('mode');
      expect(response.body).toHaveProperty('username');
      expect(response.body).toHaveProperty('email');
      expect(response.body).toHaveProperty('avatarUrl');
      expect(mockGetGitStatus).toHaveBeenCalledOnce();
    });

    it('should return authenticated status from getGitStatus', async () => {
      const authenticatedStatus = {
        ...defaultGitStatus,
        github: {
          ...defaultGitStatus.github,
          authenticated: true,
          mode: 'full',
          username: 'testuser',
          email: 'test@example.com',
          avatarUrl: 'https://avatars.githubusercontent.com/u/12345',
        },
      };
      mockGetGitStatus.mockReturnValue(authenticatedStatus);

      const response = await request(app)
        .get('/api/github/login-status');

      expect(response.status).toBe(200);
      expect(response.body.authenticated).toBe(true);
      expect(response.body.mode).toBe('full');
      expect(response.body.username).toBe('testuser');
      expect(response.body.email).toBe('test@example.com');
      expect(response.body.avatarUrl).toBe('https://avatars.githubusercontent.com/u/12345');
    });

    it('should not expose code/url when login is not in progress', async () => {
      // After a fresh module import, login is not in progress
      const response = await request(app)
        .get('/api/github/login-status');

      expect(response.status).toBe(200);
      expect(response.body.inProgress).toBe(false);
      expect(response.body.code).toBeNull();
      expect(response.body.url).toBeNull();
    });

    it('should return default values when not authenticated', async () => {
      const response = await request(app)
        .get('/api/github/login-status');

      expect(response.status).toBe(200);
      expect(response.body.authenticated).toBe(false);
      expect(response.body.mode).toBeNull();
      expect(response.body.username).toBeNull();
      expect(response.body.email).toBeNull();
      expect(response.body.avatarUrl).toBeNull();
    });
  });
});
