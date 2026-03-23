/**
 * Unit tests for services/environment.ts
 *
 * Tests deployment mode detection, Docker socket detection,
 * and default configuration per deployment mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock hoisted values ──
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}));

// Mock fs.existsSync — used to detect /.dockerenv and /var/run/docker.sock
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

import {
  detectDeploymentMode,
  detectDockerSocketMount,
  getDefaultConfig,
  type DeploymentMode,
} from '../../apps/runtime/src/services/environment.js';

describe('services/environment.ts - detectDeploymentMode', () => {
  const originalSystemdPid = process.env.SYSTEMD_EXEC_PID;

  afterEach(() => {
    // Restore original env
    if (originalSystemdPid !== undefined) {
      process.env.SYSTEMD_EXEC_PID = originalSystemdPid;
    } else {
      delete process.env.SYSTEMD_EXEC_PID;
    }
    vi.restoreAllMocks();
  });

  it('should return "systemd" when SYSTEMD_EXEC_PID is set', () => {
    process.env.SYSTEMD_EXEC_PID = '12345';
    const mode = detectDeploymentMode();
    expect(mode).toBe('systemd');
  });

  it('should return "docker" when /.dockerenv exists (and no systemd)', () => {
    delete process.env.SYSTEMD_EXEC_PID;
    mockExistsSync.mockImplementation((path: string) => path === '/.dockerenv');

    const mode = detectDeploymentMode();
    expect(mode).toBe('docker');
  });

  it('should return "cli-local" as fallback', () => {
    delete process.env.SYSTEMD_EXEC_PID;
    mockExistsSync.mockReturnValue(false);

    const mode = detectDeploymentMode();
    expect(mode).toBe('cli-local');
  });

  it('should prioritize systemd over docker', () => {
    process.env.SYSTEMD_EXEC_PID = '99';
    mockExistsSync.mockReturnValue(true); // /.dockerenv exists too

    const mode = detectDeploymentMode();
    expect(mode).toBe('systemd');
  });
});

describe('services/environment.ts - detectDockerSocketMount', () => {
  const originalSystemdPid = process.env.SYSTEMD_EXEC_PID;

  afterEach(() => {
    if (originalSystemdPid !== undefined) {
      process.env.SYSTEMD_EXEC_PID = originalSystemdPid;
    } else {
      delete process.env.SYSTEMD_EXEC_PID;
    }
    vi.restoreAllMocks();
  });

  it('should return true when in docker mode and docker.sock exists', () => {
    delete process.env.SYSTEMD_EXEC_PID;
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/.dockerenv') return true;
      if (path === '/var/run/docker.sock') return true;
      return false;
    });

    expect(detectDockerSocketMount()).toBe(true);
  });

  it('should return false when in docker mode but docker.sock does not exist', () => {
    delete process.env.SYSTEMD_EXEC_PID;
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/.dockerenv') return true;
      return false;
    });

    expect(detectDockerSocketMount()).toBe(false);
  });

  it('should return false when not in docker mode (systemd)', () => {
    process.env.SYSTEMD_EXEC_PID = '123';
    mockExistsSync.mockReturnValue(true);

    expect(detectDockerSocketMount()).toBe(false);
  });

  it('should return false when not in docker mode (cli-local)', () => {
    delete process.env.SYSTEMD_EXEC_PID;
    mockExistsSync.mockReturnValue(false); // no /.dockerenv

    expect(detectDockerSocketMount()).toBe(false);
  });
});

describe('services/environment.ts - getDefaultConfig', () => {
  it('should return systemd defaults', () => {
    const config = getDefaultConfig('systemd');
    expect(config.workspace).toBe('/home/codeck/workspace');
    expect(config.port).toBe(80);
  });

  it('should return docker defaults', () => {
    const config = getDefaultConfig('docker');
    expect(config.workspace).toBe('/workspace');
    expect(config.port).toBe(80);
  });

  it('should return cli-local defaults', () => {
    const config = getDefaultConfig('cli-local');
    expect(config.workspace).toBe(process.cwd());
    expect(config.port).toBe(3000);
  });

  it('should return correct types for all modes', () => {
    const modes: DeploymentMode[] = ['systemd', 'docker', 'cli-local'];
    for (const mode of modes) {
      const config = getDefaultConfig(mode);
      expect(typeof config.workspace).toBe('string');
      expect(typeof config.port).toBe('number');
      expect(config.workspace.length).toBeGreaterThan(0);
      expect(config.port).toBeGreaterThan(0);
    }
  });
});
