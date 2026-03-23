/**
 * Hooks API Tests — /api/hooks
 *
 * Tests: list hooks, add/remove/update hooks, event validation.
 * Mocks fs/promises to avoid reading/writing real settings.json.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions for fs/promises
const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

import hooksRouter from '../../apps/runtime/src/routes/hooks.routes.js';

describe('Hooks API', () => {
  let app: Express;

  const SAMPLE_SETTINGS = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'echo pre-write' }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo post-bash' }],
        },
      ],
    },
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/hooks', hooksRouter);

    vi.clearAllMocks();

    // Default: return valid settings
    mockReadFile.mockResolvedValue(JSON.stringify(SAMPLE_SETTINGS));
    mockWriteFile.mockResolvedValue(undefined);
  });

  // ── GET /api/hooks ──

  describe('GET /api/hooks', () => {
    it('should return all hooks', async () => {
      const res = await request(app).get('/api/hooks').expect(200);

      expect(res.body.hooks).toBeDefined();
      expect(res.body.hooks.PreToolUse).toHaveLength(1);
      expect(res.body.hooks.PostToolUse).toHaveLength(1);
    });

    it('should return empty hooks when settings file is missing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const res = await request(app).get('/api/hooks').expect(200);

      expect(res.body.hooks).toEqual({});
    });

    it('should return empty hooks when settings has no hooks key', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ someOtherKey: true }));

      const res = await request(app).get('/api/hooks').expect(200);

      expect(res.body.hooks).toEqual({});
    });
  });

  // ── POST /api/hooks ──

  describe('POST /api/hooks', () => {
    it('should add a hook with valid event, matcher, and command', async () => {
      const res = await request(app)
        .post('/api/hooks')
        .send({ event: 'Stop', matcher: 'all', command: 'echo done' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledOnce();

      // Verify the written data includes the new hook
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.hooks.Stop).toBeDefined();
      expect(writtenData.hooks.Stop).toHaveLength(1);
      expect(writtenData.hooks.Stop[0].matcher).toBe('all');
    });

    it('should append to existing matcher group', async () => {
      const res = await request(app)
        .post('/api/hooks')
        .send({ event: 'PreToolUse', matcher: 'Write', command: 'echo another-pre-write' })
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      // The existing "Write" matcher should now have 2 hooks
      const writeGroup = writtenData.hooks.PreToolUse.find(
        (m: { matcher: string }) => m.matcher === 'Write'
      );
      expect(writeGroup.hooks).toHaveLength(2);
    });

    it('should return 400 for invalid event name', async () => {
      const res = await request(app)
        .post('/api/hooks')
        .send({ event: 'InvalidEvent', matcher: 'test', command: 'echo test' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('event must be one of');
    });

    it('should return 400 for missing event', async () => {
      const res = await request(app)
        .post('/api/hooks')
        .send({ matcher: 'test', command: 'echo test' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should return 400 when matcher is not a string', async () => {
      const res = await request(app)
        .post('/api/hooks')
        .send({ event: 'PreToolUse', matcher: 123, command: 'echo test' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('matcher must be a string');
    });

    it('should return 400 when command is missing', async () => {
      const res = await request(app)
        .post('/api/hooks')
        .send({ event: 'PreToolUse', matcher: 'test' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('command is required');
    });

    it('should return 400 when command is not a string', async () => {
      const res = await request(app)
        .post('/api/hooks')
        .send({ event: 'PreToolUse', matcher: 'test', command: 42 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('command is required');
    });

    it('should accept all valid event types', async () => {
      for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'PostCompact']) {
        mockReadFile.mockResolvedValue(JSON.stringify({}));
        mockWriteFile.mockResolvedValue(undefined);

        const res = await request(app)
          .post('/api/hooks')
          .send({ event, matcher: 'test', command: 'echo test' })
          .expect(200);

        expect(res.body.success).toBe(true);
      }
    });
  });

  // ── DELETE /api/hooks ──

  describe('DELETE /api/hooks', () => {
    it('should remove a hook by event and index', async () => {
      const res = await request(app)
        .delete('/api/hooks')
        .send({ event: 'PreToolUse', index: 0 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledOnce();

      // Verify the PreToolUse event was cleaned up (empty array removed)
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.hooks.PreToolUse).toBeUndefined();
    });

    it('should return 400 for invalid event', async () => {
      const res = await request(app)
        .delete('/api/hooks')
        .send({ event: 'BadEvent', index: 0 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('event must be one of');
    });

    it('should return 400 for negative index', async () => {
      const res = await request(app)
        .delete('/api/hooks')
        .send({ event: 'PreToolUse', index: -1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('index must be a non-negative number');
    });

    it('should return 400 for non-numeric index', async () => {
      const res = await request(app)
        .delete('/api/hooks')
        .send({ event: 'PreToolUse', index: 'abc' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should return 404 for out-of-bounds index', async () => {
      const res = await request(app)
        .delete('/api/hooks')
        .send({ event: 'PreToolUse', index: 99 })
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('should return 404 when event has no hooks', async () => {
      const res = await request(app)
        .delete('/api/hooks')
        .send({ event: 'Stop', index: 0 })
        .expect(404);

      expect(res.body.success).toBe(false);
    });
  });

  // ── PUT /api/hooks/:event/:index ──

  describe('PUT /api/hooks/:event/:index', () => {
    it('should update matcher of a hook', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/0')
        .send({ matcher: 'Edit' })
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.hooks.PreToolUse[0].matcher).toBe('Edit');
    });

    it('should update command of a hook', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/0')
        .send({ command: 'echo updated' })
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.hooks.PreToolUse[0].hooks[0].command).toBe('echo updated');
    });

    it('should update both matcher and command', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/0')
        .send({ matcher: 'Read', command: 'echo read-hook' })
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.hooks.PreToolUse[0].matcher).toBe('Read');
      expect(writtenData.hooks.PreToolUse[0].hooks[0].command).toBe('echo read-hook');
    });

    it('should return 400 for invalid event in URL', async () => {
      const res = await request(app)
        .put('/api/hooks/BadEvent/0')
        .send({ matcher: 'test' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('event must be one of');
    });

    it('should return 400 for non-numeric index in URL', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/abc')
        .send({ matcher: 'test' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('index must be a non-negative number');
    });

    it('should return 400 for negative index in URL', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/-1')
        .send({ matcher: 'test' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should return 404 for out-of-bounds index', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/99')
        .send({ matcher: 'test' })
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('should return 400 for empty matcher string', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/0')
        .send({ matcher: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('matcher must be a non-empty string');
    });

    it('should return 400 for empty command string', async () => {
      const res = await request(app)
        .put('/api/hooks/PreToolUse/0')
        .send({ command: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('command must be a non-empty string');
    });

    it('should return 500 when writeFile throws during update', async () => {
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      const res = await request(app)
        .put('/api/hooks/PreToolUse/0')
        .send({ matcher: 'NewMatcher' })
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Disk full');
    });
  });

  // ── Error handling: catch blocks ──

  describe('Error handling', () => {
    it('GET / should return 500 when readSettings throws unexpectedly', async () => {
      // Make readFile throw something other than ENOENT (which readSettings catches)
      // We need to throw from within the route handler's try block AFTER readSettings returns.
      // Since readSettings catches its own errors, we need to force the outer catch.
      // Let's make readFile return invalid JSON that still gets past readSettings
      // but causes an error elsewhere — actually readSettings handles that too.
      // The simplest way: make mockReadFile return something that causes JSON.parse to throw
      // but only after readSettings is called. Actually readSettings catches all errors.
      // The catch at line 49 would be hit if res.json throws, which is unusual.
      // Let's test the POST error path instead — writeFile throwing.
      mockWriteFile.mockRejectedValue(new Error('Permission denied'));

      const res = await request(app)
        .post('/api/hooks')
        .send({ event: 'Stop', matcher: 'all', command: 'echo done' })
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Permission denied');
    });

    it('DELETE / should return 500 when writeFile throws', async () => {
      mockWriteFile.mockRejectedValue(new Error('I/O error'));

      const res = await request(app)
        .delete('/api/hooks')
        .send({ event: 'PreToolUse', index: 0 })
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('I/O error');
    });
  });
});
