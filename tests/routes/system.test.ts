/**
 * System API Tests — /api/system
 *
 * Tests: network-info, port validation (add/remove), input sanitization.
 * Mocks port-manager and console services to avoid Docker CLI calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockGetNetworkInfo, mockIsPortExposed, mockGetMappedPorts,
  mockGetCodeckPort, mockAddMappedPort, mockRemoveMappedPort,
  mockWritePortOverride, mockSpawnComposeRestart, mockCanAutoRestart,
} = vi.hoisted(() => ({
  mockGetNetworkInfo: vi.fn(),
  mockIsPortExposed: vi.fn(),
  mockGetMappedPorts: vi.fn(),
  mockGetCodeckPort: vi.fn(),
  mockAddMappedPort: vi.fn(),
  mockRemoveMappedPort: vi.fn(),
  mockWritePortOverride: vi.fn(),
  mockSpawnComposeRestart: vi.fn(),
  mockCanAutoRestart: vi.fn(),
}));

vi.mock('../../apps/runtime/src/services/port-manager.js', () => ({
  getNetworkInfo: mockGetNetworkInfo,
  isPortExposed: mockIsPortExposed,
  getMappedPorts: mockGetMappedPorts,
  getCodeckPort: mockGetCodeckPort,
  addMappedPort: mockAddMappedPort,
  removeMappedPort: mockRemoveMappedPort,
  writePortOverride: mockWritePortOverride,
  spawnComposeRestart: mockSpawnComposeRestart,
  canAutoRestart: mockCanAutoRestart,
}));

vi.mock('../../apps/runtime/src/services/console.js', () => ({
  saveSessionState: vi.fn(),
  updateAgentBinary: vi.fn(() => ({ version: '1.0.0', binaryPath: '/usr/bin/claude' })),
}));

// Ensure no DAEMON_URL so we test isolated mode
delete process.env.CODECK_DAEMON_URL;

import systemRouter from '../../apps/runtime/src/routes/system.routes.js';

describe('System API', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/system', systemRouter);

    vi.clearAllMocks();

    // Defaults
    mockGetNetworkInfo.mockReturnValue({
      mode: 'bridge',
      mappedPorts: [80],
      containerId: 'abc123',
    });
    mockGetCodeckPort.mockReturnValue(80);
    mockGetMappedPorts.mockReturnValue([80]);
    mockCanAutoRestart.mockReturnValue(false);
  });

  // ── GET /api/system/network-info ──

  describe('GET /api/system/network-info', () => {
    it('should return network mode and ports', async () => {
      const res = await request(app).get('/api/system/network-info').expect(200);

      expect(res.body.mode).toBe('bridge');
      expect(res.body.mappedPorts).toContain(80);
      expect(res.body.containerId).toBe('abc123');
    });
  });

  // ── POST /api/system/add-port (input validation) ──

  describe('POST /api/system/add-port', () => {
    it('should reject port 0', async () => {
      await request(app)
        .post('/api/system/add-port')
        .send({ port: 0 })
        .expect(400);
    });

    it('should reject negative port', async () => {
      await request(app)
        .post('/api/system/add-port')
        .send({ port: -1 })
        .expect(400);
    });

    it('should reject port > 65535', async () => {
      await request(app)
        .post('/api/system/add-port')
        .send({ port: 99999 })
        .expect(400);
    });

    it('should reject string port', async () => {
      await request(app)
        .post('/api/system/add-port')
        .send({ port: 'abc' })
        .expect(400);
    });

    it('should reject missing port', async () => {
      await request(app)
        .post('/api/system/add-port')
        .send({})
        .expect(400);
    });

    it('should report already mapped port', async () => {
      mockIsPortExposed.mockReturnValue(true);

      const res = await request(app)
        .post('/api/system/add-port')
        .send({ port: 80 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.alreadyMapped).toBe(true);
    });

    it('should report requiresRestart when auto-restart is unavailable', async () => {
      mockIsPortExposed.mockReturnValue(false);
      mockCanAutoRestart.mockReturnValue(false);

      const res = await request(app)
        .post('/api/system/add-port')
        .send({ port: 3000 })
        .expect(200);

      expect(res.body.success).toBe(false);
      expect(res.body.requiresRestart).toBe(true);
      expect(res.body.instructions).toContain('3000');
    });
  });

  // ── POST /api/system/remove-port (input validation) ──

  describe('POST /api/system/remove-port', () => {
    it('should reject invalid port numbers', async () => {
      for (const port of [0, -1, 99999, 'abc', null]) {
        await request(app)
          .post('/api/system/remove-port')
          .send({ port })
          .expect(400);
      }
    });

    it('should report not-mapped port', async () => {
      mockIsPortExposed.mockReturnValue(false);

      const res = await request(app)
        .post('/api/system/remove-port')
        .send({ port: 9999 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.notMapped).toBe(true);
    });

    it('should prevent removing the Codeck port', async () => {
      mockIsPortExposed.mockReturnValue(true);
      mockGetCodeckPort.mockReturnValue(80);

      const res = await request(app)
        .post('/api/system/remove-port')
        .send({ port: 80 })
        .expect(400);

      expect(res.body.error).toContain('Codeck port');
    });
  });

  // ── POST /api/system/update-agent ──

  describe('POST /api/system/update-agent', () => {
    it('should return success with version info', async () => {
      const res = await request(app)
        .post('/api/system/update-agent')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.version).toBeDefined();
    });
  });
});
