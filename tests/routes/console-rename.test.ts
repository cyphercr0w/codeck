/**
 * tests/routes/console-rename.test.ts
 *
 * Tests for POST /api/console/rename endpoint
 * Renames a PTY session with XSS protection (HTML tag stripping)
 * Validates name length (1-200 chars) and session existence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const { mockRenameSession } = vi.hoisted(() => ({
  mockRenameSession: vi.fn(),
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
  destroySession: vi.fn(),
  renameSession: mockRenameSession,
  listSessions: vi.fn(() => []),
  hasResumableConversations: vi.fn(),
}));

vi.mock('../../src/web/websocket.js', () => ({
  broadcastStatus: vi.fn(),
}));

// Import router after mocks
import consoleRouter from '../../src/routes/console.routes.js';

describe('POST /api/console/rename', () => {
  let app: Express;

  beforeEach(() => {
    // Create test Express app
    app = express();
    app.use(express.json());
    app.use('/api/console', consoleRouter);

    // Reset mocks
    vi.clearAllMocks();

    // Default mock behaviors
    mockRenameSession.mockReturnValue(true); // Success by default
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should rename session successfully', async () => {
    // Arrange
    const sessionId = 'session-123';
    const name = 'My Project';

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockRenameSession).toHaveBeenCalledOnce();
    expect(mockRenameSession).toHaveBeenCalledWith('session-123', 'My Project');
  });

  it('should return 404 when session not found', async () => {
    // Arrange
    mockRenameSession.mockReturnValue(false); // Session not found

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId: 'nonexistent', name: 'Test' });

    // Assert
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Session not found' });
    expect(mockRenameSession).toHaveBeenCalledOnce();
    expect(mockRenameSession).toHaveBeenCalledWith('nonexistent', 'Test');
  });

  it('should reject when sessionId is missing', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ name: 'Test' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId and name required',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it('should reject when name is missing', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId: 'session-123' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId and name required',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it('should reject when name is not a string', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId: 'session-123', name: 123 });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId and name required',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it('should strip HTML tags from name (XSS protection)', async () => {
    // Arrange
    const sessionId = 'session-123';
    const maliciousName = '<script>alert("XSS")</script>Hacked';

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: maliciousName });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockRenameSession).toHaveBeenCalledOnce();
    // Note: regex /<[^>]*>/g removes tags but keeps content between them
    expect(mockRenameSession).toHaveBeenCalledWith('session-123', 'alert("XSS")Hacked');
  });

  it('should strip all HTML tags and trim whitespace', async () => {
    // Arrange
    const sessionId = 'session-123';
    const nameWithHtml = '  <div><b>Bold</b> <i>Italic</i></div>  ';

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: nameWithHtml });

    // Assert
    expect(response.status).toBe(200);
    expect(mockRenameSession).toHaveBeenCalledOnce();
    expect(mockRenameSession).toHaveBeenCalledWith('session-123', 'Bold Italic'); // HTML stripped, whitespace trimmed
  });

  it('should reject when name is empty after sanitization', async () => {
    // Arrange
    const sessionId = 'session-123';
    const onlyHtmlTags = '<div><script></script></div>';

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: onlyHtmlTags });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Name must be 1-200 characters (no HTML)',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it('should reject when name exceeds 200 characters', async () => {
    // Arrange
    const sessionId = 'session-123';
    const longName = 'A'.repeat(201);

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: longName });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Name must be 1-200 characters (no HTML)',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it('should accept name with exactly 200 characters', async () => {
    // Arrange
    const sessionId = 'session-123';
    const maxLengthName = 'A'.repeat(200);

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: maxLengthName });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockRenameSession).toHaveBeenCalledOnce();
    expect(mockRenameSession).toHaveBeenCalledWith('session-123', maxLengthName);
  });

  it('should accept name with exactly 1 character', async () => {
    // Arrange
    const sessionId = 'session-123';
    const minLengthName = 'A';

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: minLengthName });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockRenameSession).toHaveBeenCalledOnce();
    expect(mockRenameSession).toHaveBeenCalledWith('session-123', 'A');
  });

  it('should reject when name is only whitespace', async () => {
    // Arrange
    const sessionId = 'session-123';
    const whitespaceOnlyName = '   ';

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: whitespaceOnlyName });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Name must be 1-200 characters (no HTML)',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it('should accept special characters and unicode', async () => {
    // Arrange
    const sessionId = 'session-123';
    const specialName = 'Project 🚀 (v1.0) — Production';

    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId, name: specialName });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockRenameSession).toHaveBeenCalledOnce();
    expect(mockRenameSession).toHaveBeenCalledWith('session-123', specialName);
  });

  it('should handle sessionId as null', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId: null, name: 'Test' });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId and name required',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it('should handle name as null', async () => {
    // Act
    const response = await request(app)
      .post('/api/console/rename')
      .send({ sessionId: 'session-123', name: null });

    // Assert
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'sessionId and name required',
    });
    expect(mockRenameSession).not.toHaveBeenCalled();
  });
});
