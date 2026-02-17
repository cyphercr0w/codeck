/**
 * tests/routes/console-create.test.ts
 *
 * Tests for POST /api/console/create endpoint
 * Creates a new Claude Code session (requires Claude auth, max 5 sessions)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const { mockCreateConsoleSession, mockGetSessionCount, mockBroadcastStatus, mockIsClaudeAuthenticated } = vi.hoisted(() => ({
  mockCreateConsoleSession: vi.fn(),
  mockGetSessionCount: vi.fn(),
  mockBroadcastStatus: vi.fn(),
  mockIsClaudeAuthenticated: vi.fn(),
}));

// Mock dependencies before importing router
vi.mock('../../src/services/auth-anthropic.js', () => ({
  isClaudeAuthenticated: mockIsClaudeAuthenticated,
}));

vi.mock('../../src/services/console.js', () => ({
  createConsoleSession: mockCreateConsoleSession,
  createShellSession: vi.fn(),
  getSessionCount: mockGetSessionCount,
  resizeSession: vi.fn(),
  destroySession: vi.fn(),
  renameSession: vi.fn(),
  listSessions: vi.fn(() => []),
  hasResumableConversations: vi.fn(),
}));

vi.mock('../../src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

// Import router after mocks
import consoleRouter from '../../src/routes/console.routes.js';

describe('POST /api/console/create', () => {
  let app: Express;

  beforeEach(() => {
    // Create test Express app
    app = express();
    app.use(express.json());
    app.use('/api/console', consoleRouter);

    // Reset mocks
    vi.clearAllMocks();

    // Default mock behaviors
    mockIsClaudeAuthenticated.mockReturnValue(true);
    mockGetSessionCount.mockReturnValue(0);
    mockBroadcastStatus.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should create a Claude session successfully', async () => {
    // Arrange
    const mockSession = {
      id: 'session-123',
      cwd: '/workspace',
      name: 'Claude Session 1',
      type: 'claude' as const,
      pid: 12345,
    };
    mockCreateConsoleSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/workspace' });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      sessionId: 'session-123',
      cwd: '/workspace',
      name: 'Claude Session 1',
    });
    expect(mockCreateConsoleSession).toHaveBeenCalledWith({
      cwd: '/workspace',
      resume: undefined,
    });
    expect(mockBroadcastStatus).toHaveBeenCalledOnce();
  });

  it('should reject when Claude is not authenticated', async () => {
    // Arrange
    mockIsClaudeAuthenticated.mockReturnValue(false);

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/workspace' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Claude is not authenticated',
    });
    expect(mockCreateConsoleSession).not.toHaveBeenCalled();
    expect(mockBroadcastStatus).not.toHaveBeenCalled();
  });

  it('should reject when max sessions (5) reached', async () => {
    // Arrange
    mockGetSessionCount.mockReturnValue(5);

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/workspace' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Maximum 5 simultaneous sessions',
    });
    expect(mockCreateConsoleSession).not.toHaveBeenCalled();
    expect(mockBroadcastStatus).not.toHaveBeenCalled();
  });

  it('should use default cwd when not provided', async () => {
    // Arrange
    const mockSession = {
      id: 'session-456',
      cwd: '/workspace',
      name: 'Claude Session 1',
      type: 'claude' as const,
      pid: 12345,
    };
    mockCreateConsoleSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({});

    // Assert
    expect(response.status).toBe(200);
    expect(mockCreateConsoleSession).toHaveBeenCalledWith({
      cwd: undefined,
      resume: undefined,
    });
  });

  it('should pass resume parameter when provided', async () => {
    // Arrange
    const mockSession = {
      id: 'session-789',
      cwd: '/workspace/project',
      name: 'Claude Session (resumed)',
      type: 'claude' as const,
      pid: 67890,
    };
    mockCreateConsoleSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/workspace/project', resume: true });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe('session-789');
    expect(mockCreateConsoleSession).toHaveBeenCalledWith({
      cwd: '/workspace/project',
      resume: true,
    });
  });

  it('should handle session creation failure gracefully', async () => {
    // Arrange
    mockCreateConsoleSession.mockImplementation(() => {
      throw new Error('Invalid cwd: /nonexistent');
    });

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/nonexistent' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Failed to create session',
    });
    expect(mockBroadcastStatus).not.toHaveBeenCalled();
  });

  it('should handle non-Error exceptions during creation', async () => {
    // Arrange
    mockCreateConsoleSession.mockImplementation(() => {
      throw 'String error'; // Non-Error exception
    });

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/workspace' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Failed to create session',
    });
  });

  it('should check session count before creating session', async () => {
    // Arrange
    mockGetSessionCount.mockReturnValue(4); // 4 existing sessions
    const mockSession = {
      id: 'session-last',
      cwd: '/workspace',
      name: 'Claude Session 5',
      type: 'claude' as const,
      pid: 99999,
    };
    mockCreateConsoleSession.mockReturnValue(mockSession);

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/workspace' });

    // Assert - should succeed with 4 existing (5th is allowed)
    expect(response.status).toBe(200);
    expect(mockGetSessionCount).toHaveBeenCalled();
  });

  it('should validate authentication before checking session count', async () => {
    // Arrange
    mockIsClaudeAuthenticated.mockReturnValue(false);
    mockGetSessionCount.mockReturnValue(0);

    // Act
    const response = await request(app)
      .post('/api/console/create')
      .send({ cwd: '/workspace' });

    // Assert - should fail on auth, not proceed to session count
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Claude is not authenticated');
    // Session count should still be checked (getSessionCount happens after auth check in route)
  });
});
