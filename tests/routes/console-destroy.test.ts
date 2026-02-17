/**
 * tests/routes/console-destroy.test.ts
 *
 * Tests for POST /api/console/destroy endpoint
 * Destroys a PTY session (both Claude and shell sessions)
 * No session validation - destroySession is idempotent (no-op if not found)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const { mockDestroySession, mockBroadcastStatus } = vi.hoisted(() => ({
  mockDestroySession: vi.fn(),
  mockBroadcastStatus: vi.fn(),
}));

// Mock dependencies before importing router
vi.mock('../../src/services/auth-anthropic.js', () => ({
  isClaudeAuthenticated: vi.fn(() => true),
}));

vi.mock('../../src/services/console.js', () => ({
  createConsoleSession: vi.fn(),
  createShellSession: vi.fn(),
  getSessionCount: vi.fn(() => 0),
  resizeSession: vi.fn(),
  destroySession: mockDestroySession,
  renameSession: vi.fn(),
  listSessions: vi.fn(() => []),
  hasResumableConversations: vi.fn(),
}));

vi.mock('../../src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

// Import router after mocks
import consoleRouter from '../../src/routes/console.routes.js';

describe('POST /api/console/destroy', () => {
  let app: Express;

  beforeEach(() => {
    // Create test Express app
    app = express();
    app.use(express.json());
    app.use('/api/console', consoleRouter);

    // Reset mocks
    vi.clearAllMocks();

    // Default mock behaviors
    mockBroadcastStatus.mockImplementation(() => {});
    mockDestroySession.mockImplementation(() => {}); // Idempotent, no return value
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should destroy a session successfully', async () => {
    // Arrange
    const sessionId = 'session-123';

    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({ sessionId });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockDestroySession).toHaveBeenCalledOnce();
    expect(mockDestroySession).toHaveBeenCalledWith('session-123');
    expect(mockBroadcastStatus).toHaveBeenCalledOnce();
  });

  it('should reject when sessionId is missing', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({});

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId required',
    });
    expect(mockDestroySession).not.toHaveBeenCalled();
    expect(mockBroadcastStatus).not.toHaveBeenCalled();
  });

  it('should reject when sessionId is null', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({ sessionId: null });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId required',
    });
    expect(mockDestroySession).not.toHaveBeenCalled();
  });

  it('should reject when sessionId is undefined', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({ sessionId: undefined });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId required',
    });
    expect(mockDestroySession).not.toHaveBeenCalled();
  });

  it('should reject when sessionId is empty string', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({ sessionId: '' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId required',
    });
    expect(mockDestroySession).not.toHaveBeenCalled();
  });

  it('should succeed even if session does not exist (idempotent)', async () => {
    // Arrange - destroySession is idempotent (no-op if session not found)
    const sessionId = 'non-existent-session';

    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({ sessionId });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockDestroySession).toHaveBeenCalledWith('non-existent-session');
    expect(mockBroadcastStatus).toHaveBeenCalledOnce();
  });

  it('should handle UUID session IDs', async () => {
    // Arrange
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';

    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({ sessionId });

    // Assert
    expect(response.status).toBe(200);
    expect(mockDestroySession).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should call destroySession before broadcastStatus', async () => {
    // Arrange
    const callOrder: string[] = [];
    mockDestroySession.mockImplementation(() => {
      callOrder.push('destroySession');
    });
    mockBroadcastStatus.mockImplementation(() => {
      callOrder.push('broadcastStatus');
    });

    // Act
    await request(app)
      .post('/api/console/destroy')
      .send({ sessionId: 'test-session' });

    // Assert - verify order
    expect(callOrder).toEqual(['destroySession', 'broadcastStatus']);
  });

  it('should handle request with no body', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/destroy');

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId required',
    });
  });

  it('should ignore extra fields in request body', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/destroy')
      .send({
        sessionId: 'valid-session',
        extraField: 'should be ignored',
        anotherField: 123,
      });

    // Assert
    expect(response.status).toBe(200);
    expect(mockDestroySession).toHaveBeenCalledWith('valid-session');
  });
});
