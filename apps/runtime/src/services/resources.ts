import { readFileSync, statfsSync } from 'fs';
import { resolve } from 'path';
import os from 'os';
import { getSessionCount } from './console.js';
import { getActivePorts } from './ports.js';

const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const startTime = Date.now();

// CPU usage tracking for delta calculation
let prevCpuUsage = { usageUsec: 0, timestamp: Date.now() };

interface ContainerResources {
  cpu: {
    cores: number;
    usagePercent: number;
  };
  memory: {
    used: number;
    limit: number;
    percent: number;
  };
  disk: {
    used: number;
    total: number;
    percent: number;
  };
  uptime: number;
  sessions: number;
  ports: number;
}

function readCgroupFile(path: string): string | null {
  try { return readFileSync(path, 'utf-8').trim(); }
  catch (e) {
    console.debug(`[Resources] Failed to read ${path}: ${(e as Error).message}`);
    return null;
  }
}

function getMemoryUsage(): { used: number; limit: number } {
  const current = readCgroupFile('/sys/fs/cgroup/memory.current');
  const max = readCgroupFile('/sys/fs/cgroup/memory.max');

  if (current && max) {
    const used = parseInt(current);
    const limit = max === 'max' ? os.totalmem() : parseInt(max);
    return { used, limit };
  }
  // Fallback: host memory
  return { used: os.totalmem() - os.freemem(), limit: os.totalmem() };
}

function getCpuUsage(): number {
  // Try cgroups v2
  const cpuStat = readCgroupFile('/sys/fs/cgroup/cpu.stat');
  if (cpuStat) {
    const match = cpuStat.match(/usage_usec\s+(\d+)/);
    if (match) {
      const usageUsec = parseInt(match[1]);
      const now = Date.now();
      const deltaUsec = usageUsec - prevCpuUsage.usageUsec;
      const deltaMs = now - prevCpuUsage.timestamp;

      prevCpuUsage = { usageUsec, timestamp: now };

      if (deltaMs > 0 && prevCpuUsage.usageUsec > 0) {
        // Convert microseconds to percentage of wall-clock time
        const cores = os.cpus().length;
        const percent = (deltaUsec / 1000 / deltaMs) * 100 / cores;
        return Math.min(100, Math.max(0, percent));
      }
      return 0;
    }
  }

  // Fallback: load average
  const load = os.loadavg()[0];
  const cores = os.cpus().length;
  return Math.min(100, Math.max(0, (load / cores) * 100));
}

function getDiskUsage(): { used: number; total: number } {
  try {
    const stats = statfsSync(WORKSPACE);
    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    return { used: total - free, total };
  } catch {
    return { used: 0, total: 0 };
  }
}

export function getContainerResources(): ContainerResources {
  const mem = getMemoryUsage();
  const disk = getDiskUsage();
  const cpuPercent = getCpuUsage();

  return {
    cpu: {
      cores: os.cpus().length,
      usagePercent: Math.round(cpuPercent * 10) / 10,
    },
    memory: {
      used: mem.used,
      limit: mem.limit,
      percent: mem.limit > 0 ? Math.round((mem.used / mem.limit) * 1000) / 10 : 0,
    },
    disk: {
      used: disk.used,
      total: disk.total,
      percent: disk.total > 0 ? Math.round((disk.used / disk.total) * 1000) / 10 : 0,
    },
    uptime: Math.floor((Date.now() - startTime) / 1000),
    sessions: getSessionCount(),
    ports: getActivePorts().length,
  };
}
