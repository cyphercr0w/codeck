/**
 * Preset API Tests — /api/preset
 *
 * Tests: list presets, get status, apply/update/reset.
 * Mocks preset service, websocket broadcast, and git updateClaudeMd.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions
const {
  mockListPresets,
  mockGetPresetStatus,
  mockApplyPreset,
  mockIsValidPresetId,
  mockBroadcastStatus,
  mockUpdateClaudeMd,
} = vi.hoisted(() => ({
  mockListPresets: vi.fn(),
  mockGetPresetStatus: vi.fn(),
  mockApplyPreset: vi.fn(),
  mockIsValidPresetId: vi.fn(),
  mockBroadcastStatus: vi.fn(),
  mockUpdateClaudeMd: vi.fn(),
}));

vi.mock('../../apps/runtime/src/services/preset.js', () => ({
  listPresets: mockListPresets,
  getPresetStatus: mockGetPresetStatus,
  applyPreset: mockApplyPreset,
  isValidPresetId: mockIsValidPresetId,
}));

vi.mock('../../apps/runtime/src/web/websocket.js', () => ({
  broadcastStatus: mockBroadcastStatus,
}));

vi.mock('../../apps/runtime/src/services/git.js', () => ({
  updateClaudeMd: mockUpdateClaudeMd,
}));

import presetRouter from '../../apps/runtime/src/routes/preset.routes.js';

describe('Preset API', () => {
  let app: Express;

  const SAMPLE_PRESETS = [
    {
      id: 'default',
      name: 'Default Preset',
      description: 'Standard configuration for Claude Code',
      version: '7.2.0',
    },
    {
      id: 'minimal',
      name: 'Minimal Preset',
      description: 'Bare-bones configuration',
      version: '1.0.0',
    },
  ];

  const STATUS_CONFIGURED = {
    configured: true,
    presetId: 'default',
    version: '7.2.0',
  };

  const STATUS_NOT_CONFIGURED = {
    configured: false,
    presetId: null,
    version: null,
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/preset', presetRouter);

    vi.clearAllMocks();

    // Default behaviors
    mockListPresets.mockReturnValue(SAMPLE_PRESETS);
    mockGetPresetStatus.mockReturnValue(STATUS_CONFIGURED);
    mockApplyPreset.mockResolvedValue(undefined);
    mockIsValidPresetId.mockReturnValue(true);
    mockBroadcastStatus.mockReturnValue(undefined);
    mockUpdateClaudeMd.mockReturnValue(undefined);
  });

  // ── GET /api/preset ──

  describe('GET /api/preset', () => {
    it('should list all available presets', async () => {
      const res = await request(app).get('/api/preset').expect(200);

      expect(res.body).toEqual(SAMPLE_PRESETS);
      expect(mockListPresets).toHaveBeenCalledOnce();
    });

    it('should return empty array when no presets available', async () => {
      mockListPresets.mockReturnValue([]);

      const res = await request(app).get('/api/preset').expect(200);

      expect(res.body).toEqual([]);
    });
  });

  // ── GET /api/preset/status ──

  describe('GET /api/preset/status', () => {
    it('should return configured preset status', async () => {
      const res = await request(app).get('/api/preset/status').expect(200);

      expect(res.body.configured).toBe(true);
      expect(res.body.presetId).toBe('default');
      expect(mockGetPresetStatus).toHaveBeenCalledOnce();
    });

    it('should return not-configured status', async () => {
      mockGetPresetStatus.mockReturnValue(STATUS_NOT_CONFIGURED);

      const res = await request(app).get('/api/preset/status').expect(200);

      expect(res.body.configured).toBe(false);
      expect(res.body.presetId).toBeNull();
    });
  });

  // ── POST /api/preset/apply ──

  describe('POST /api/preset/apply', () => {
    it('should apply a valid preset', async () => {
      const res = await request(app)
        .post('/api/preset/apply')
        .send({ presetId: 'default' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.presetId).toBe('default');
      expect(mockApplyPreset).toHaveBeenCalledWith('default');
      expect(mockUpdateClaudeMd).toHaveBeenCalledOnce();
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return 400 for missing presetId', async () => {
      const res = await request(app)
        .post('/api/preset/apply')
        .send({})
        .expect(400);

      expect(res.body.error).toBe('presetId is required');
    });

    it('should return 400 for non-string presetId', async () => {
      const res = await request(app)
        .post('/api/preset/apply')
        .send({ presetId: 123 })
        .expect(400);

      expect(res.body.error).toBe('presetId is required');
    });

    it('should return 400 for invalid presetId format', async () => {
      mockIsValidPresetId.mockReturnValue(false);

      const res = await request(app)
        .post('/api/preset/apply')
        .send({ presetId: '../../../etc/passwd' })
        .expect(400);

      expect(res.body.error).toContain('Invalid presetId');
      expect(mockIsValidPresetId).toHaveBeenCalledWith('../../../etc/passwd');
    });

    it('should return 500 when applyPreset throws', async () => {
      mockApplyPreset.mockRejectedValue(new Error('Manifest not found'));

      const res = await request(app)
        .post('/api/preset/apply')
        .send({ presetId: 'nonexistent' })
        .expect(500);

      expect(res.body.error).toContain('Failed to apply preset');
    });
  });

  // ── POST /api/preset/update ──

  describe('POST /api/preset/update', () => {
    it('should re-apply current preset', async () => {
      const res = await request(app)
        .post('/api/preset/update')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.presetId).toBe('default');
      expect(res.body.message).toContain('Preset updated');
      expect(mockApplyPreset).toHaveBeenCalledWith('default');
      expect(mockUpdateClaudeMd).toHaveBeenCalledOnce();
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return 400 when no preset is configured', async () => {
      mockGetPresetStatus.mockReturnValue(STATUS_NOT_CONFIGURED);

      const res = await request(app)
        .post('/api/preset/update')
        .expect(400);

      expect(res.body.error).toBe('No preset configured');
    });

    it('should return 500 when applyPreset throws during update', async () => {
      mockApplyPreset.mockRejectedValue(new Error('File system error'));

      const res = await request(app)
        .post('/api/preset/update')
        .expect(500);

      expect(res.body.error).toContain('Failed to update preset');
    });
  });

  // ── POST /api/preset/reset ──

  describe('POST /api/preset/reset', () => {
    it('should force re-apply current preset', async () => {
      const res = await request(app)
        .post('/api/preset/reset')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.presetId).toBe('default');
      // Reset calls applyPreset with force=true
      expect(mockApplyPreset).toHaveBeenCalledWith('default', true);
      expect(mockUpdateClaudeMd).toHaveBeenCalledOnce();
      expect(mockBroadcastStatus).toHaveBeenCalledOnce();
    });

    it('should return 400 when no preset is configured', async () => {
      mockGetPresetStatus.mockReturnValue(STATUS_NOT_CONFIGURED);

      const res = await request(app)
        .post('/api/preset/reset')
        .expect(400);

      expect(res.body.error).toBe('No preset configured');
    });

    it('should return 500 when applyPreset throws during reset', async () => {
      mockApplyPreset.mockRejectedValue(new Error('Corrupt manifest'));

      const res = await request(app)
        .post('/api/preset/reset')
        .expect(500);

      expect(res.body.error).toContain('Failed to reset preset');
    });
  });
});
