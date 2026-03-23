/**
 * Dashboard API Tests — /api/dashboard
 *
 * Tests: combined dashboard data (GET /), memory stats (GET /memory-stats).
 * Mocks resources, agent-usage, and memory-stats services.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockGetContainerResources,
  mockGetClaudeUsage,
  mockGetMemoryStats,
} = vi.hoisted(() => ({
  mockGetContainerResources: vi.fn(),
  mockGetClaudeUsage: vi.fn(),
  mockGetMemoryStats: vi.fn(),
}));

vi.mock('../../apps/runtime/src/services/resources.js', () => ({
  getContainerResources: mockGetContainerResources,
}));

vi.mock('../../apps/runtime/src/services/agent-usage.js', () => ({
  getClaudeUsage: mockGetClaudeUsage,
}));

vi.mock('../../apps/runtime/src/services/memory-stats.js', () => ({
  getMemoryStats: mockGetMemoryStats,
}));

import dashboardRouter from '../../apps/runtime/src/routes/dashboard.routes.js';

describe('Dashboard API', () => {
  let app: Express;

  const SAMPLE_RESOURCES = {
    cpu: { usage: 25.5, cores: 4 },
    memory: { used: 1024, total: 8192, percent: 12.5 },
    disk: { used: 10240, total: 102400, percent: 10 },
  };

  const SAMPLE_CLAUDE_USAGE = {
    totalTokens: 50000,
    inputTokens: 30000,
    outputTokens: 20000,
    sessions: 5,
  };

  const SAMPLE_MEMORY_STATS = {
    totalFiles: 42,
    totalSize: 128000,
    dailyEntries: 15,
    decisions: 3,
    paths: 7,
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/dashboard', dashboardRouter);

    vi.clearAllMocks();

    // Default behaviors
    mockGetContainerResources.mockReturnValue(SAMPLE_RESOURCES);
    mockGetClaudeUsage.mockResolvedValue(SAMPLE_CLAUDE_USAGE);
    mockGetMemoryStats.mockResolvedValue(SAMPLE_MEMORY_STATS);
  });

  // ── GET /api/dashboard ──

  describe('GET /api/dashboard', () => {
    it('should return combined resources and claude usage', async () => {
      const res = await request(app).get('/api/dashboard').expect(200);

      expect(res.body.resources).toEqual(SAMPLE_RESOURCES);
      expect(res.body.claude).toEqual(SAMPLE_CLAUDE_USAGE);
    });

    it('should call both service functions', async () => {
      await request(app).get('/api/dashboard').expect(200);

      expect(mockGetContainerResources).toHaveBeenCalledOnce();
      expect(mockGetClaudeUsage).toHaveBeenCalledOnce();
    });

    it('should handle resources returning empty data', async () => {
      mockGetContainerResources.mockReturnValue({});
      mockGetClaudeUsage.mockResolvedValue({});

      const res = await request(app).get('/api/dashboard').expect(200);

      expect(res.body.resources).toEqual({});
      expect(res.body.claude).toEqual({});
    });
  });

  // ── GET /api/dashboard/memory-stats ──

  describe('GET /api/dashboard/memory-stats', () => {
    it('should return memory stats', async () => {
      const res = await request(app).get('/api/dashboard/memory-stats').expect(200);

      expect(res.body).toEqual(SAMPLE_MEMORY_STATS);
    });

    it('should call getMemoryStats', async () => {
      await request(app).get('/api/dashboard/memory-stats').expect(200);

      expect(mockGetMemoryStats).toHaveBeenCalledOnce();
    });

    it('should return 500 when getMemoryStats throws', async () => {
      mockGetMemoryStats.mockRejectedValue(new Error('SQLite error'));

      const res = await request(app).get('/api/dashboard/memory-stats').expect(500);

      expect(res.body.error).toBe('Failed to load memory stats');
    });
  });
});
