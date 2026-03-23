/**
 * Unit tests for services/resources.ts
 *
 * Tests getContainerResources: memory, CPU, disk metrics,
 * uptime calculation, and cgroup fallback behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock hoisted values ──
const {
  mockReadFileSync, mockStatfsSync, mockGetSessionCount, mockGetActivePorts,
  mockCpus, mockTotalmem, mockFreemem, mockLoadavg,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockStatfsSync: vi.fn(),
  mockGetSessionCount: vi.fn(() => 0),
  mockGetActivePorts: vi.fn(() => []),
  mockCpus: vi.fn(() => [{ model: 'mock', speed: 2400 }, { model: 'mock', speed: 2400 }]),
  mockTotalmem: vi.fn(() => 4 * 1024 * 1024 * 1024),
  mockFreemem: vi.fn(() => 1 * 1024 * 1024 * 1024),
  mockLoadavg: vi.fn(() => [0.5, 0.3, 0.2]),
}));

// Mock fs — readFileSync for cgroup files, statfsSync for disk
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    statfsSync: mockStatfsSync,
  };
});

// Mock os module
vi.mock('os', () => ({
  default: {
    cpus: mockCpus,
    totalmem: mockTotalmem,
    freemem: mockFreemem,
    loadavg: mockLoadavg,
  },
  cpus: mockCpus,
  totalmem: mockTotalmem,
  freemem: mockFreemem,
  loadavg: mockLoadavg,
}));

// Mock console service
vi.mock('../../apps/runtime/src/services/console.js', () => ({
  getSessionCount: mockGetSessionCount,
}));

// Mock ports service
vi.mock('../../apps/runtime/src/services/ports.js', () => ({
  getActivePorts: mockGetActivePorts,
}));

import { getContainerResources } from '../../apps/runtime/src/services/resources.js';

describe('services/resources.ts - getContainerResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: cgroup files not available (triggers fallback)
    mockReadFileSync.mockImplementation((path: string) => {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    });

    // Default disk stats
    mockStatfsSync.mockReturnValue({
      blocks: 1000000,
      bsize: 4096,
      bfree: 500000,
    });

    mockGetSessionCount.mockReturnValue(2);
    mockGetActivePorts.mockReturnValue([{ port: 3000 }, { port: 8080 }]);
    mockCpus.mockReturnValue([{ model: 'mock', speed: 2400 }, { model: 'mock', speed: 2400 }]);
    mockTotalmem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockFreemem.mockReturnValue(1 * 1024 * 1024 * 1024);
    mockLoadavg.mockReturnValue([0.5, 0.3, 0.2]);
  });

  it('should return a valid ContainerResources object', () => {
    const res = getContainerResources();

    expect(res).toHaveProperty('cpu');
    expect(res).toHaveProperty('memory');
    expect(res).toHaveProperty('disk');
    expect(res).toHaveProperty('uptime');
    expect(res).toHaveProperty('sessions');
    expect(res).toHaveProperty('ports');
  });

  it('should return CPU info with cores and usage', () => {
    const res = getContainerResources();

    expect(res.cpu.cores).toBe(2);
    expect(typeof res.cpu.usagePercent).toBe('number');
    expect(res.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(res.cpu.usagePercent).toBeLessThanOrEqual(100);
  });

  it('should fall back to os.totalmem/freemem when cgroup files are absent', () => {
    const res = getContainerResources();

    // With fallback: used = totalmem - freemem = 4GB - 1GB = 3GB
    expect(res.memory.used).toBe(3 * 1024 * 1024 * 1024);
    expect(res.memory.limit).toBe(4 * 1024 * 1024 * 1024);
    expect(res.memory.percent).toBeGreaterThan(0);
    expect(res.memory.percent).toBeLessThanOrEqual(100);
  });

  it('should read memory from cgroup v2 files when available', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/sys/fs/cgroup/memory.current') return '1073741824'; // 1GB
      if (path === '/sys/fs/cgroup/memory.max') return '2147483648';    // 2GB
      throw new Error('ENOENT');
    });

    const res = getContainerResources();

    expect(res.memory.used).toBe(1073741824);
    expect(res.memory.limit).toBe(2147483648);
    expect(res.memory.percent).toBeCloseTo(50, 0);
  });

  it('should handle memory.max="max" (unlimited) by falling back to os.totalmem', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/sys/fs/cgroup/memory.current') return '500000000';
      if (path === '/sys/fs/cgroup/memory.max') return 'max';
      throw new Error('ENOENT');
    });

    const res = getContainerResources();

    expect(res.memory.used).toBe(500000000);
    expect(res.memory.limit).toBe(4 * 1024 * 1024 * 1024); // os.totalmem fallback
  });

  it('should compute disk usage from statfsSync', () => {
    mockStatfsSync.mockReturnValue({
      blocks: 1000,
      bsize: 1024,    // 1KB blocks
      bfree: 400,     // 400 free blocks
    });

    const res = getContainerResources();

    expect(res.disk.total).toBe(1000 * 1024);          // 1,024,000 bytes
    expect(res.disk.used).toBe((1000 - 400) * 1024);   // 614,400 bytes
    expect(res.disk.percent).toBeGreaterThan(0);
  });

  it('should handle statfsSync failure gracefully', () => {
    mockStatfsSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const res = getContainerResources();

    expect(res.disk.used).toBe(0);
    expect(res.disk.total).toBe(0);
    expect(res.disk.percent).toBe(0);
  });

  it('should report uptime in seconds', () => {
    const res = getContainerResources();
    expect(typeof res.uptime).toBe('number');
    expect(res.uptime).toBeGreaterThanOrEqual(0);
  });

  it('should report session count from console service', () => {
    mockGetSessionCount.mockReturnValue(5);
    const res = getContainerResources();
    expect(res.sessions).toBe(5);
  });

  it('should report port count from ports service', () => {
    mockGetActivePorts.mockReturnValue([{ port: 80 }, { port: 443 }, { port: 3000 }]);
    const res = getContainerResources();
    expect(res.ports).toBe(3);
  });

  it('should fall back to load average when cgroup cpu.stat is absent', () => {
    // All readFileSync calls throw (no cgroup files)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const res = getContainerResources();

    // Load avg = 0.5, cores = 2, fallback = (0.5/2)*100 = 25%
    expect(res.cpu.usagePercent).toBe(25);
  });

  it('should cap CPU percentage at 100%', () => {
    // Simulate very high load
    mockLoadavg.mockReturnValue([10.0, 5.0, 3.0]);

    const res = getContainerResources();
    expect(res.cpu.usagePercent).toBeLessThanOrEqual(100);
  });

  it('should calculate memory percent correctly', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/sys/fs/cgroup/memory.current') return '750000000';  // 750MB
      if (path === '/sys/fs/cgroup/memory.max') return '1000000000';     // 1GB
      throw new Error('ENOENT');
    });

    const res = getContainerResources();
    expect(res.memory.percent).toBe(75);
  });

  it('should round disk percent to one decimal', () => {
    mockStatfsSync.mockReturnValue({
      blocks: 3,
      bsize: 1000,
      bfree: 1,
    });

    const res = getContainerResources();
    // used = 2000, total = 3000 -> 66.666...%
    expect(res.disk.percent).toBe(66.7);
  });

  it('should handle zero memory limit without division by zero', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/sys/fs/cgroup/memory.current') return '0';
      if (path === '/sys/fs/cgroup/memory.max') return '0';
      throw new Error('ENOENT');
    });
    // When limit is 0, os.totalmem is used because parseInt('0') is falsy... actually no, 0 is truthy for cgroup.
    // Let's check: the code does `if (current && max)` — '0' is truthy, so it enters the branch.
    // limit = parseInt('0') = 0
    // percent formula: limit > 0 ? ... : 0
    const res = getContainerResources();
    expect(res.memory.percent).toBe(0);
  });

  it('should report zero sessions and ports when none active', () => {
    mockGetSessionCount.mockReturnValue(0);
    mockGetActivePorts.mockReturnValue([]);

    const res = getContainerResources();
    expect(res.sessions).toBe(0);
    expect(res.ports).toBe(0);
  });
});
