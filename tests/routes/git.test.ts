/**
 * Git API Tests — /api/git
 *
 * Tests: clone repository with URL validation, token handling, SSH option.
 * Mocks git service and websocket broadcast.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockCloneRepository,
  mockBroadcastStatus,
} = vi.hoisted(() => ({
  mockCloneRepository: vi.fn(),
  mockBroadcastStatus: vi.fn(),
}));

vi.mock('../../apps/runtime/src/services/git.js', () => ({
  cloneRepository: mockCloneRepository,
}));

vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

import gitRouter from '../../apps/runtime/src/routes/git.routes.js';

describe('Git API', () => {
  let app: Express;

  const SAMPLE_CLONE_RESULT = {
    success: true,
    repoName: 'my-project',
    path: '/workspace/my-project',
    message: 'Repository cloned successfully',
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/git', gitRouter);

    vi.clearAllMocks();

    // Default behaviors
    mockCloneRepository.mockResolvedValue(SAMPLE_CLONE_RESULT);
    mockBroadcastStatus.mockReturnValue(undefined);
  });

  // ── POST /api/git/clone ──

  describe('POST /api/git/clone', () => {
    it('should clone with a valid URL', async () => {
      const res = await request(app)
        .post('/api/git/clone')
        .send({ url: 'https://github.com/user/repo.git' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.repoName).toBe('my-project');
      expect(mockCloneRepository).toHaveBeenCalledWith(
        'https://github.com/user/repo.git',
        undefined,
        undefined,
      );
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return 400 for missing URL', async () => {
      const res = await request(app)
        .post('/api/git/clone')
        .send({})
        .expect(400);

      expect(res.body.error).toContain('URL required');
      expect(mockCloneRepository).not.toHaveBeenCalled();
    });

    it('should return 400 for non-string URL', async () => {
      const res = await request(app)
        .post('/api/git/clone')
        .send({ url: 12345 })
        .expect(400);

      expect(res.body.error).toContain('URL required');
    });

    it('should return 400 for URL too long', async () => {
      const longUrl = 'https://github.com/' + 'a'.repeat(2100);

      const res = await request(app)
        .post('/api/git/clone')
        .send({ url: longUrl })
        .expect(400);

      expect(res.body.error).toContain('URL too long');
    });

    it('should accept URL at exactly 2048 characters', async () => {
      const url = 'https://github.com/' + 'a'.repeat(2048 - 'https://github.com/'.length);

      const res = await request(app)
        .post('/api/git/clone')
        .send({ url })
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should clone with optional token', async () => {
      const res = await request(app)
        .post('/api/git/clone')
        .send({
          url: 'https://github.com/user/private-repo.git',
          token: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockCloneRepository).toHaveBeenCalledWith(
        'https://github.com/user/private-repo.git',
        'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        undefined,
      );
    });

    it('should return 400 for invalid token format (too long)', async () => {
      const longToken = 'a'.repeat(501);

      const res = await request(app)
        .post('/api/git/clone')
        .send({ url: 'https://github.com/user/repo.git', token: longToken })
        .expect(400);

      expect(res.body.error).toContain('Invalid token format');
    });

    it('should return 400 for non-string token', async () => {
      const res = await request(app)
        .post('/api/git/clone')
        .send({ url: 'https://github.com/user/repo.git', token: 12345 })
        .expect(400);

      expect(res.body.error).toContain('Invalid token format');
    });

    it('should pass useSSH option to cloneRepository', async () => {
      const res = await request(app)
        .post('/api/git/clone')
        .send({ url: 'git@github.com:user/repo.git', useSSH: true })
        .expect(200);

      expect(mockCloneRepository).toHaveBeenCalledWith(
        'git@github.com:user/repo.git',
        undefined,
        true,
      );
    });

    it('should broadcast status after successful clone', async () => {
      await request(app)
        .post('/api/git/clone')
        .send({ url: 'https://github.com/user/repo.git' })
        .expect(200);

      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return clone failure result', async () => {
      mockCloneRepository.mockResolvedValue({
        success: false,
        error: 'Repository not found',
      });

      const res = await request(app)
        .post('/api/git/clone')
        .send({ url: 'https://github.com/user/nonexistent.git' })
        .expect(200);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Repository not found');
    });
  });
});
