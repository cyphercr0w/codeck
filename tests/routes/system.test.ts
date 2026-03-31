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
