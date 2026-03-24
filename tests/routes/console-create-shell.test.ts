/**
 * tests/routes/console-create-shell.test.ts
 *
 * Tests for POST /api/console/create-shell endpoint
 * Creates a new shell (bash) session — does NOT require Claude auth
 * Still protected by password auth middleware (server.ts)
 * Shares the max 5 session limit with Claude sessions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const { mockCreateShellSession, mockGetSessionCount, mockBroadcastStatus } = vi.hoisted(() => ({
  mockCreateShellSession: vi.fn(),
  mockGetSessionCount: vi.fn(),
  mockBroadcastStatus: vi.fn(),
}));

// Mock dependencies before importing router
vi.mock('../../apps/runtime/src/services/auth-anthropic.js', () => ({
  isClaudeAuthenticated: vi.fn(() => false), // Shell sessions don't check this
}));

vi.mock('../../apps/runtime/src/services/console.js', () => ({
  createConsoleSession: vi.fn(),
  createShellSession: mockCreateShellSession,
  getSessionCount: mockGetSessionCount,
  MAX_SESSIONS: 5,
  resizeSession: vi.fn(),
  destroySession: vi.fn(),
  renameSession: vi.fn(),
  listSessions: vi.fn(() => []),
  hasResumableConversations: vi.fn(),
}));

vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

// Import router after mocks
import consoleRouter from '../../apps/runtime/src/routes/console.routes.js';

describe('POST /api/console/create-shell', () => {
  let app: Express;
  const TEST_WORKSPACE = process.env.WORKSPACE || '/workspace';

  beforeEach(() => {
    // Create test Express app
    app = express();
    app.use(express.json());
    app.use('/api/console', consoleRouter);

    // Reset mocks
    vi.clearAllMocks();

    // Default mock behaviors
    mockGetSessionCount.mockReturnValue(0);
    mockBroadcastStatus.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should create a shell session successfully', async () => {
    // Arrange
    const mockSession = {
      id: 'shell-session-123',
      cwd: TEST_WORKSPACE,
      name: 'Shell Session 1',
      type: 'shell' as const,
      pid: 54321,
    };
    mockCreateShellSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: TEST_WORKSPACE });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      sessionId: 'shell-session-123',
      cwd: TEST_WORKSPACE,
      name: 'Shell Session 1',
    });
    expect(mockCreateShellSession).toHaveBeenCalledWith(TEST_WORKSPACE);
    expect(mockBroadcastStatus).toHaveBeenCalledOnce();
  });

  it('should create shell session without Claude authentication', async () => {
    // Arrange
    const mockSession = {
      id: 'shell-session-456',
      cwd: TEST_WORKSPACE,
      name: 'Shell Session 1',
      type: 'shell' as const,
      pid: 54322,
    };
    mockCreateShellSession.mockReturnValue(mockSession);

    // Act - Even if Claude is not authenticated, shell sessions should work
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: TEST_WORKSPACE });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe('shell-session-456');
    expect(mockCreateShellSession).toHaveBeenCalledOnce();
  });

  it('should reject when max sessions (5) reached', async () => {
    // Arrange - 5 sessions already exist (could be Claude or shell)
    mockGetSessionCount.mockReturnValue(5);

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: TEST_WORKSPACE });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Maximum 5 simultaneous sessions',
    });
    expect(mockCreateShellSession).not.toHaveBeenCalled();
    expect(mockBroadcastStatus).not.toHaveBeenCalled();
  });

  it('should use default cwd when not provided', async () => {
    // Arrange
    const mockSession = {
      id: 'shell-session-789',
      cwd: TEST_WORKSPACE,
      name: 'Shell Session 1',
      type: 'shell' as const,
      pid: 54323,
    };
    mockCreateShellSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({});

    // Assert
    expect(response.status).toBe(200);
    expect(mockCreateShellSession).toHaveBeenCalledWith(undefined);
  });

  it('should accept custom cwd', async () => {
    // Arrange
    const mockSession = {
      id: 'shell-session-custom',
      cwd: `${TEST_WORKSPACE}/custom-project`,
      name: 'Shell Session 1',
      type: 'shell' as const,
      pid: 54324,
    };
    mockCreateShellSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: `${TEST_WORKSPACE}/custom-project` });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body.cwd).toBe(`${TEST_WORKSPACE}/custom-project`);
    expect(mockCreateShellSession).toHaveBeenCalledWith(`${TEST_WORKSPACE}/custom-project`);
  });

  it('should handle shell session creation failure gracefully', async () => {
    // Arrange
    mockCreateShellSession.mockImplementation(() => {
      throw new Error('Failed to spawn process');
    });

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: `${TEST_WORKSPACE}/nonexistent` });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Failed to create shell session',
    });
    expect(mockBroadcastStatus).not.toHaveBeenCalled();
  });

  it('should handle non-Error exceptions during creation', async () => {
    // Arrange
    mockCreateShellSession.mockImplementation(() => {
      throw 'String error'; // Non-Error exception
    });

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: TEST_WORKSPACE });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Failed to create shell session',
    });
  });

  it('should check session count before creating shell session', async () => {
    // Arrange
    mockGetSessionCount.mockReturnValue(4); // 4 existing sessions
    const mockSession = {
      id: 'shell-session-last',
      cwd: TEST_WORKSPACE,
      name: 'Shell Session 5',
      type: 'shell' as const,
      pid: 99998,
    };
    mockCreateShellSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: TEST_WORKSPACE });

    // Assert - should succeed with 4 existing (5th is allowed)
    expect(response.status).toBe(200);
    expect(mockGetSessionCount).toHaveBeenCalled();
  });

  it('should not check Claude authentication for shell sessions', async () => {
    // Arrange - Claude is not authenticated
    const mockSession = {
      id: 'shell-no-claude',
      cwd: TEST_WORKSPACE,
      name: 'Shell Session 1',
      type: 'shell' as const,
      pid: 77777,
    };
    mockCreateShellSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create-shell')
      .send({ cwd: TEST_WORKSPACE });

    // Assert - should succeed even without Claude auth
    expect(response.status).toBe(200);
    expect(mockCreateShellSession).toHaveBeenCalled();
    // The route does not call isClaudeAuthenticated for shell sessions
  });

  it('should handle empty request body', async () => {
    // Arrange
    const mockSession = {
      id: 'shell-empty-body',
      cwd: TEST_WORKSPACE,
      name: 'Shell Session 1',
      type: 'shell' as const,
      pid: 88888,
    };
    mockCreateShellSession.mockReturnValue(mockSession);

    // Act - No body at all
    const response = await request(app)
      .post('/api/console/create-shell');

    // Assert
    expect(response.status).toBe(200);
    expect(mockCreateShellSession).toHaveBeenCalledWith(undefined);
  });
});
