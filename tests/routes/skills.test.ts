/**
 * tests/routes/skills.test.ts
 *
 * Tests for skills routes:
 *   GET    /api/skills/catalog   — search skills via CLI
 *   GET    /api/skills/installed — list installed skill names
 *   POST   /api/skills/install   — install a skill
 *   DELETE /api/skills/uninstall — remove an installed skill
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockExecFile,
  mockReaddir,
  mockRm,
} = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockRm: vi.fn(),
}));

// Mock child_process (execFile via promisify)
vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// Mock util.promisify to return our mock directly
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readdir: mockReaddir,
  rm: mockRm,
}));

// Import router after mocks
import skillsRouter from '../../apps/runtime/src/routes/skills.routes.js';

describe('Skills Routes', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/skills', skillsRouter);

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /catalog ──────────────────────────────────────────────────

  describe('GET /catalog', () => {
    it('should search skills with valid query', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'user/repo@my-skill  Some description  150 installs\n',
        stderr: '',
      });

      const response = await request(app)
        .get('/api/skills/catalog?q=testing');

      expect(response.status).toBe(200);
      expect(response.body.skills).toBeDefined();
      expect(Array.isArray(response.body.skills)).toBe(true);
    });

    it('should return empty skills array without query', async () => {
      const response = await request(app)
        .get('/api/skills/catalog');

      expect(response.status).toBe(200);
      expect(response.body.skills).toEqual([]);
      // Should not call execFile when query is empty
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should return empty skills array with empty query string', async () => {
      const response = await request(app)
        .get('/api/skills/catalog?q=');

      expect(response.status).toBe(200);
      expect(response.body.skills).toEqual([]);
    });

    it('should parse skills output with install counts', async () => {
      mockExecFile.mockResolvedValue({
        stdout: [
          'author/package@skill-one  A testing skill  2.5K installs',
          'org/lib@skill-two  Another skill  100 installs',
          'dev/tools@skill-three  Cool tool  1.2M installs',
        ].join('\n'),
        stderr: '',
      });

      const response = await request(app)
        .get('/api/skills/catalog?q=skill');

      expect(response.status).toBe(200);
      expect(response.body.skills).toHaveLength(3);
      expect(response.body.skills[0]).toEqual({
        source: 'author/package',
        skillId: 'skill-one',
        name: 'skill-one',
        installs: 2500,
      });
      expect(response.body.skills[1].installs).toBe(100);
      expect(response.body.skills[2].installs).toBe(1200000);
    });

    it('should return empty array when CLI fails', async () => {
      mockExecFile.mockRejectedValue(new Error('Command failed'));

      const response = await request(app)
        .get('/api/skills/catalog?q=test');

      expect(response.status).toBe(200);
      expect(response.body.skills).toEqual([]);
    });

    it('should use cached results for repeated queries', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'user/repo@cached-skill  Cached  50 installs\n',
        stderr: '',
      });

      // First call
      await request(app).get('/api/skills/catalog?q=cached');
      // Second call — should use cache
      await request(app).get('/api/skills/catalog?q=cached');

      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /installed ────────────────────────────────────────────────

  describe('GET /installed', () => {
    it('should list installed skills', async () => {
      mockReaddir.mockResolvedValue(['skill-a', 'skill-b', '.hidden']);

      const response = await request(app)
        .get('/api/skills/installed');

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual(['skill-a', 'skill-b']);
    });

    it('should return empty array when no skills installed', async () => {
      mockReaddir.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/skills/installed');

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual([]);
    });

    it('should return empty array when skills directory does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const response = await request(app)
        .get('/api/skills/installed');

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual([]);
    });

    it('should filter out hidden files (starting with dot)', async () => {
      mockReaddir.mockResolvedValue(['.DS_Store', '.gitkeep', 'visible-skill']);

      const response = await request(app)
        .get('/api/skills/installed');

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual(['visible-skill']);
    });
  });

  // ── POST /install ─────────────────────────────────────────────────

  describe('POST /install', () => {
    it('should install a skill with valid source and skillId', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'Installed successfully',
        stderr: '',
      });

      const response = await request(app)
        .post('/api/skills/install')
        .send({ source: 'author/package', skillId: 'my-skill' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.output).toContain('Installed successfully');
    });

    it('should return 400 when source is missing', async () => {
      const response = await request(app)
        .post('/api/skills/install')
        .send({ skillId: 'my-skill' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('source and skillId required');
    });

    it('should return 400 when skillId is missing', async () => {
      const response = await request(app)
        .post('/api/skills/install')
        .send({ source: 'author/package' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('source and skillId required');
    });

    it('should return 400 when both source and skillId are missing', async () => {
      const response = await request(app)
        .post('/api/skills/install')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('source and skillId required');
    });

    it('should return 400 when source format is invalid', async () => {
      const response = await request(app)
        .post('/api/skills/install')
        .send({ source: 'invalid-source', skillId: 'my-skill' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid source format');
    });

    it('should return 400 when source contains path traversal', async () => {
      const response = await request(app)
        .post('/api/skills/install')
        .send({ source: '../../../etc', skillId: 'passwd' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid source format');
    });

    it('should return 400 when skillId format is invalid', async () => {
      const response = await request(app)
        .post('/api/skills/install')
        .send({ source: 'author/package', skillId: 'skill/with/slashes' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid skillId format');
    });

    it('should return 500 when installation CLI fails', async () => {
      mockExecFile.mockRejectedValue({
        stdout: '',
        stderr: 'Install failed: package not found',
      });

      const response = await request(app)
        .post('/api/skills/install')
        .send({ source: 'author/package', skillId: 'nonexistent' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Installation failed');
    });

    it('should accept source with dots and hyphens', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'OK', stderr: '' });

      const response = await request(app)
        .post('/api/skills/install')
        .send({ source: 'my-org/cool.package', skillId: 'v1.0-skill' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  // ── DELETE /uninstall ─────────────────────────────────────────────

  describe('DELETE /uninstall', () => {
    it('should uninstall a skill by name', async () => {
      mockRm.mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({ name: 'my-skill' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 when name is missing', async () => {
      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('name is required');
    });

    it('should return 400 when name is not a string', async () => {
      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({ name: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('name is required');
    });

    it('should return 400 when name contains path traversal (..)', async () => {
      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({ name: '../etc' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid skill name');
    });

    it('should return 400 when name contains forward slash', async () => {
      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({ name: 'path/traversal' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid skill name');
    });

    it('should return 400 when name contains backslash', async () => {
      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({ name: 'path\\traversal' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid skill name');
    });

    it('should return 400 when name starts with dot', async () => {
      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({ name: '.hidden' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid skill name');
    });

    it('should return 500 when rm fails', async () => {
      mockRm.mockRejectedValue(new Error('EPERM: operation not permitted'));

      const response = await request(app)
        .delete('/api/skills/uninstall')
        .send({ name: 'locked-skill' });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Failed to remove skill');
    });
  });
});
