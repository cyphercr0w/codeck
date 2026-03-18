/**
 * Agents API Tests — /api/agents
 *
 * Tests: CRUD operations, pause/resume, objective linting, validation.
 * Mocks the proactive-agents service to avoid spawning real processes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockCreateAgent, mockGetAgent, mockListAgents,
  mockUpdateAgent, mockDeleteAgent, mockPauseAgent,
  mockResumeAgent, mockTriggerAgent, mockGetAgentOutput,
  mockGetAgentLogs, mockGetAgentExecutions, mockLintAgentObjective,
} = vi.hoisted(() => ({
  mockCreateAgent: vi.fn(),
  mockGetAgent: vi.fn(),
  mockListAgents: vi.fn(),
  mockUpdateAgent: vi.fn(),
  mockDeleteAgent: vi.fn(),
  mockPauseAgent: vi.fn(),
  mockResumeAgent: vi.fn(),
  mockTriggerAgent: vi.fn(),
  mockGetAgentOutput: vi.fn(),
  mockGetAgentLogs: vi.fn(),
  mockGetAgentExecutions: vi.fn(),
  mockLintAgentObjective: vi.fn(),
}));

vi.mock('../../apps/runtime/src/services/proactive-agents.js', () => ({
  createAgent: mockCreateAgent,
  getAgent: mockGetAgent,
  listAgents: mockListAgents,
  updateAgent: mockUpdateAgent,
  deleteAgent: mockDeleteAgent,
  pauseAgent: mockPauseAgent,
  resumeAgent: mockResumeAgent,
  triggerAgent: mockTriggerAgent,
  getAgentOutput: mockGetAgentOutput,
  getAgentLogs: mockGetAgentLogs,
  getAgentExecutions: mockGetAgentExecutions,
  lintAgentObjective: mockLintAgentObjective,
}));

vi.mock('../../apps/runtime/src/services/session-writer.js', () => ({
  sanitizeSecrets: vi.fn((s: string) => s),
}));

import agentsRouter from '../../apps/runtime/src/routes/agents.routes.js';

describe('Agents API', () => {
  let app: Express;

  const WORKSPACE = process.env.WORKSPACE || '/workspace';

  const SAMPLE_AGENT = {
    id: 'agent-001',
    name: 'Test Agent',
    objective: 'Run tests every hour',
    schedule: '0 * * * *',
    status: 'active',
    cwd: WORKSPACE,
    createdAt: Date.now(),
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/agents', agentsRouter);

    vi.clearAllMocks();

    // Default behaviors
    mockLintAgentObjective.mockReturnValue([]);
    mockListAgents.mockReturnValue([]);
    mockGetAgentExecutions.mockReturnValue([]);
  });

  // ── POST /api/agents/lint ──

  describe('POST /api/agents/lint', () => {
    it('should return empty warnings for safe objective', async () => {
      mockLintAgentObjective.mockReturnValue([]);

      const res = await request(app)
        .post('/api/agents/lint')
        .send({ objective: 'Run vitest every hour' })
        .expect(200);

      expect(res.body.warnings).toEqual([]);
    });

    it('should return warnings for suspicious Docker patterns', async () => {
      mockLintAgentObjective.mockReturnValue([
        { pattern: 'docker run', severity: 'high', message: 'Docker execution detected' },
      ]);

      const res = await request(app)
        .post('/api/agents/lint')
        .send({ objective: 'Run docker run --privileged' })
        .expect(200);

      expect(res.body.warnings).toHaveLength(1);
      expect(res.body.warnings[0].severity).toBe('high');
    });

    it('should return empty warnings for missing objective', async () => {
      const res = await request(app)
        .post('/api/agents/lint')
        .send({})
        .expect(200);

      expect(res.body.warnings).toEqual([]);
    });
  });

  // ── POST /api/agents (create) ──

  describe('POST /api/agents', () => {
    it('should create an agent successfully', async () => {
      mockCreateAgent.mockReturnValue(SAMPLE_AGENT);

      const res = await request(app)
        .post('/api/agents')
        .send({
          name: 'Test Agent',
          objective: 'Run tests every hour',
          schedule: '0 * * * *',
          cwd: WORKSPACE,
        })
        .expect(200);

      expect(res.body.id).toBe('agent-001');
      expect(res.body.name).toBe('Test Agent');
      expect(mockCreateAgent).toHaveBeenCalledOnce();
    });

    it('should return lint warnings alongside created agent', async () => {
      mockCreateAgent.mockReturnValue(SAMPLE_AGENT);
      mockLintAgentObjective.mockReturnValue([
        { pattern: 'rm -rf', severity: 'medium', message: 'Destructive command' },
      ]);

      const res = await request(app)
        .post('/api/agents')
        .send({
          name: 'Risky Agent',
          objective: 'Run rm -rf /tmp/*',
          schedule: '0 * * * *',
        })
        .expect(200);

      expect(res.body.lintWarnings).toHaveLength(1);
    });

    it('should reject cwd outside workspace', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({
          name: 'Evil Agent',
          objective: 'hack',
          schedule: '* * * * *',
          cwd: '/etc',
        })
        .expect(400);

      expect(res.body.error).toContain('within');
    });

    it('should return 400 when creation throws', async () => {
      mockCreateAgent.mockImplementation(() => {
        throw new Error('Invalid cron: bad schedule');
      });

      const res = await request(app)
        .post('/api/agents')
        .send({
          name: 'Bad Agent',
          objective: 'test',
          schedule: 'not-cron',
        })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── GET /api/agents (list) ──

  describe('GET /api/agents', () => {
    it('should list all agents', async () => {
      mockListAgents.mockReturnValue([SAMPLE_AGENT]);

      const res = await request(app).get('/api/agents').expect(200);

      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].id).toBe('agent-001');
    });

    it('should return empty array when no agents', async () => {
      mockListAgents.mockReturnValue([]);

      const res = await request(app).get('/api/agents').expect(200);

      expect(res.body.agents).toEqual([]);
    });
  });

  // ── GET /api/agents/:id ──

  describe('GET /api/agents/:id', () => {
    it('should return agent detail', async () => {
      mockGetAgent.mockReturnValue(SAMPLE_AGENT);

      const res = await request(app).get('/api/agents/agent-001').expect(200);

      expect(res.body.id).toBe('agent-001');
      expect(res.body.objective).toBe('Run tests every hour');
    });

    it('should return 404 for nonexistent agent', async () => {
      mockGetAgent.mockReturnValue(null);

      await request(app).get('/api/agents/nope').expect(404);
    });
  });

  // ── PUT /api/agents/:id (update) ──

  describe('PUT /api/agents/:id', () => {
    it('should update agent config', async () => {
      mockUpdateAgent.mockReturnValue({ ...SAMPLE_AGENT, name: 'Updated Agent' });

      const res = await request(app)
        .put('/api/agents/agent-001')
        .send({ name: 'Updated Agent' })
        .expect(200);

      expect(res.body.name).toBe('Updated Agent');
    });

    it('should return 404 for nonexistent agent', async () => {
      mockUpdateAgent.mockReturnValue(null);

      await request(app)
        .put('/api/agents/nope')
        .send({ name: 'Ghost' })
        .expect(404);
    });

    it('should reject cwd outside workspace', async () => {
      await request(app)
        .put('/api/agents/agent-001')
        .send({ cwd: '/etc/shadow' })
        .expect(400);
    });
  });

  // ── POST /api/agents/:id/pause ──

  describe('POST /api/agents/:id/pause', () => {
    it('should pause an agent', async () => {
      mockPauseAgent.mockReturnValue({ ...SAMPLE_AGENT, status: 'paused' });

      const res = await request(app)
        .post('/api/agents/agent-001/pause')
        .expect(200);

      expect(res.body.status).toBe('paused');
    });

    it('should return 404 for nonexistent agent', async () => {
      mockPauseAgent.mockReturnValue(null);

      await request(app)
        .post('/api/agents/nope/pause')
        .expect(404);
    });
  });

  // ── POST /api/agents/:id/resume ──

  describe('POST /api/agents/:id/resume', () => {
    it('should resume an agent', async () => {
      mockResumeAgent.mockReturnValue({ ...SAMPLE_AGENT, status: 'active' });

      const res = await request(app)
        .post('/api/agents/agent-001/resume')
        .expect(200);

      expect(res.body.status).toBe('active');
    });

    it('should return 404 for nonexistent agent', async () => {
      mockResumeAgent.mockReturnValue(null);

      await request(app)
        .post('/api/agents/nope/resume')
        .expect(404);
    });
  });

  // ── POST /api/agents/:id/execute ──

  describe('POST /api/agents/:id/execute', () => {
    it('should trigger agent execution', async () => {
      mockTriggerAgent.mockReturnValue({ executionId: 'exec-001' });

      const res = await request(app)
        .post('/api/agents/agent-001/execute')
        .expect(200);

      expect(res.body.executionId).toBe('exec-001');
    });

    it('should return 404 for nonexistent agent', async () => {
      mockTriggerAgent.mockReturnValue(null);

      await request(app)
        .post('/api/agents/nope/execute')
        .expect(404);
    });

    it('should return 400 when trigger fails', async () => {
      mockTriggerAgent.mockImplementation(() => {
        throw new Error('Agent is paused');
      });

      await request(app)
        .post('/api/agents/agent-001/execute')
        .expect(400);
    });
  });

  // ── DELETE /api/agents/:id ──

  describe('DELETE /api/agents/:id', () => {
    it('should delete an agent', async () => {
      mockDeleteAgent.mockReturnValue(true);

      const res = await request(app)
        .delete('/api/agents/agent-001')
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should return 404 for nonexistent agent', async () => {
      mockDeleteAgent.mockReturnValue(false);

      await request(app)
        .delete('/api/agents/nope')
        .expect(404);
    });
  });

  // ── GET /api/agents/:id/output ──

  describe('GET /api/agents/:id/output', () => {
    it('should return live output', async () => {
      mockGetAgentOutput.mockReturnValue('Running tests...\nAll passed!');

      const res = await request(app)
        .get('/api/agents/agent-001/output')
        .expect(200);

      expect(res.text).toContain('Running tests');
    });

    it('should return 404 when no output', async () => {
      mockGetAgentOutput.mockReturnValue(null);

      await request(app)
        .get('/api/agents/agent-001/output')
        .expect(404);
    });
  });

  // ── GET /api/agents/:id/logs ──

  describe('GET /api/agents/:id/logs', () => {
    it('should return logs as text', async () => {
      mockGetAgentLogs.mockReturnValue('2026-03-17 12:00:00 | Started\n2026-03-17 12:01:00 | Done');

      const res = await request(app)
        .get('/api/agents/agent-001/logs')
        .expect(200);

      expect(res.text).toContain('Started');
    });

    it('should return 404 when no logs', async () => {
      mockGetAgentLogs.mockReturnValue(null);

      await request(app)
        .get('/api/agents/agent-001/logs')
        .expect(404);
    });
  });

  // ── GET /api/agents/:id/executions ──

  describe('GET /api/agents/:id/executions', () => {
    it('should return execution history', async () => {
      mockGetAgentExecutions.mockReturnValue([
        { id: 'exec-001', result: 'success', startedAt: Date.now() },
      ]);

      const res = await request(app)
        .get('/api/agents/agent-001/executions')
        .expect(200);

      expect(res.body.executions).toHaveLength(1);
    });

    it('should respect limit parameter', async () => {
      const res = await request(app)
        .get('/api/agents/agent-001/executions?limit=5')
        .expect(200);

      expect(mockGetAgentExecutions).toHaveBeenCalledWith('agent-001', 5);
    });

    it('should cap limit at 1000', async () => {
      await request(app)
        .get('/api/agents/agent-001/executions?limit=9999')
        .expect(200);

      expect(mockGetAgentExecutions).toHaveBeenCalledWith('agent-001', 1000);
    });

    it('should default limit to 20', async () => {
      await request(app)
        .get('/api/agents/agent-001/executions')
        .expect(200);

      expect(mockGetAgentExecutions).toHaveBeenCalledWith('agent-001', 20);
    });
  });
});
