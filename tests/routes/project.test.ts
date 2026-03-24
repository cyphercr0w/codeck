/**
 * tests/routes/project.test.ts
 *
 * Tests for project routes:
 *   POST /api/project/create — create empty project directory
 *   POST /api/project/clone  — clone a git repository (validation only)
 *
 * NOTE: Node built-in modules (fs/promises, child_process) cannot be reliably
 * mocked with vitest's restoreMocks:true config for these route modules.
 * Create tests use the real filesystem via the test workspace.
 * Clone tests cover all validation paths (which respond before spawn).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { existsSync, rmSync, mkdirSync } from 'fs';

// Hoist mock functions for service-level mocks (these work with restoreMocks)
const {
  mockIsValidGitUrl,
  mockCheckDiskSpace,
  mockUpdateClaudeMd,
  mockBroadcastStatus,
} = vi.hoisted(() => ({
  mockIsValidGitUrl: vi.fn(),
  mockCheckDiskSpace: vi.fn(),
  mockUpdateClaudeMd: vi.fn(),
  mockBroadcastStatus: vi.fn(),
}));

// Mock service dependencies (local modules — these mock properly)
vi.mock('../../apps/runtime/src/services/git.js', () => ({
  updateClaudeMd: mockUpdateClaudeMd,
  isValidGitUrl: mockIsValidGitUrl,
  checkDiskSpace: mockCheckDiskSpace,
}));

vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

// Import router after mocks
import projectRouter from '../../apps/runtime/src/routes/project.routes.js';

// Test workspace from setup.ts
const TEST_WORKSPACE = process.env.WORKSPACE || '/tmp/codeck-test/workspace';

describe('Project Routes', () => {
  let app: Express;
  const createdDirs: string[] = [];

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/project', projectRouter);

    vi.clearAllMocks();

    // Default mock behaviors
    mockIsValidGitUrl.mockReturnValue(true);
    mockCheckDiskSpace.mockReturnValue(null);

    // Ensure test workspace exists
    if (!existsSync(TEST_WORKSPACE)) {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Clean up created test directories
    for (const dir of createdDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  function trackDir(name: string) {
    createdDirs.push(`${TEST_WORKSPACE}/${name}`);
  }

  // ── POST /create ──────────────────────────────────────────────────

  describe('POST /create', () => {
    it('should create a project with a valid name', async () => {
      trackDir('test-project');

      const response = await request(app)
        .post('/api/project/create')
        .send({ name: 'test-project' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.name).toBe('test-project');
      expect(response.body.path).toContain('test-project');
      expect(existsSync(`${TEST_WORKSPACE}/test-project`)).toBe(true);
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return 400 when name is missing', async () => {
      const response = await request(app)
        .post('/api/project/create')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('name is required');
    });

    it('should return 400 when name is not a string', async () => {
      const response = await request(app)
        .post('/api/project/create')
        .send({ name: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('name is required');
    });

    it('should return 400 when name is empty string', async () => {
      const response = await request(app)
        .post('/api/project/create')
        .send({ name: '' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('name is required');
    });

    it('should return 400 when name is null', async () => {
      const response = await request(app)
        .post('/api/project/create')
        .send({ name: null });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('name is required');
    });

    it('should return 400 when name has only invalid chars', async () => {
      const response = await request(app)
        .post('/api/project/create')
        .send({ name: '!@#$%^&*()' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Project name can only contain');
    });

    it('should sanitize name by removing invalid characters', async () => {
      trackDir('myprojecttest');

      const response = await request(app)
        .post('/api/project/create')
        .send({ name: 'my<project>test' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('myprojecttest');
    });

    it('should return 400 when sanitized name exceeds 100 characters', async () => {
      const response = await request(app)
        .post('/api/project/create')
        .send({ name: 'A'.repeat(101) });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('100 characters or less');
    });

    it('should accept name with exactly 100 characters', async () => {
      const longName = 'A'.repeat(100);
      trackDir(longName);

      const response = await request(app)
        .post('/api/project/create')
        .send({ name: longName });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 409 when directory already exists', async () => {
      const dirPath = `${TEST_WORKSPACE}/existing-project`;
      mkdirSync(dirPath, { recursive: true });
      createdDirs.push(dirPath);

      const response = await request(app)
        .post('/api/project/create')
        .send({ name: 'existing-project' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Directory already exists');
    });

    it('should strip leading dots from name', async () => {
      trackDir('hidden');

      const response = await request(app)
        .post('/api/project/create')
        .send({ name: '...hidden' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('hidden');
    });

    it('should accept names with spaces, dots, hyphens, underscores', async () => {
      const name = 'My Project v1.0 - test_run';
      trackDir(name);

      const response = await request(app)
        .post('/api/project/create')
        .send({ name });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.name).toBe(name);
    });

    it('should return 400 when name is only whitespace', async () => {
      const response = await request(app)
        .post('/api/project/create')
        .send({ name: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Project name can only contain');
    });
  });

  // ── POST /clone — validation ──────────────────────────────────────
  // These tests cover all validation paths that respond BEFORE spawn is called.

  describe('POST /clone', () => {
    it('should return 400 when URL is missing', async () => {
      const response = await request(app)
        .post('/api/project/clone')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('url is required');
    });

    it('should return 400 when URL is not a string', async () => {
      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('url is required');
    });

    it('should return 400 when URL is empty string', async () => {
      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: '' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('url is required');
    });

    it('should return 400 when URL is invalid (SSRF/protocol check)', async () => {
      mockIsValidGitUrl.mockReturnValue(false);

      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'file:///etc/passwd' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid repository URL');
      expect(mockIsValidGitUrl).toHaveBeenCalledWith('file:///etc/passwd');
    });

    it('should return 400 when branch contains spaces', async () => {
      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'https://github.com/user/repo.git', branch: 'my branch' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid branch name');
    });

    it('should return 400 when branch is not a string', async () => {
      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'https://github.com/user/repo.git', branch: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid branch name');
    });

    it('should return 400 when branch contains shell metacharacters', async () => {
      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'https://github.com/user/repo.git', branch: 'main; rm -rf /' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid branch name');
    });

    it('should return 409 when target directory already exists', async () => {
      // Pre-create the directory
      const dirPath = `${TEST_WORKSPACE}/repo`;
      mkdirSync(dirPath, { recursive: true });
      createdDirs.push(dirPath);

      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'https://github.com/user/repo.git' });

      expect(response.status).toBe(409);
      expect(response.body.error).toContain('already exists');
    });

    it('should return 507 when disk space is insufficient', async () => {
      mockCheckDiskSpace.mockReturnValue('Insufficient disk space');

      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'https://github.com/user/repo.git' });

      // The route creates the dir first, then checks disk space.
      // If mkdir succeeds, it continues to checkDiskSpace.
      // Clean up the directory that was created.
      trackDir('repo');

      expect(response.status).toBe(507);
      expect(response.body.error).toBe('Insufficient disk space');
    });

    it('should return 400 when name after sanitization is empty', async () => {
      // URL that produces empty name after sanitization
      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'https://github.com/user/repo.git', name: '!@#$' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Could not determine project name');
    });

    it('should return 400 when name after sanitization exceeds 100 chars', async () => {
      const response = await request(app)
        .post('/api/project/clone')
        .send({ url: 'https://github.com/user/repo.git', name: 'A'.repeat(101) });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('too long');
    });
  });
});
