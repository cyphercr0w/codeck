import { execFile } from 'child_process';
import { broadcast } from '../web/logger.js';
import { isPortExposed } from './port-manager.js';

export interface PortInfo {
  port: number;
  exposed: boolean;
}

let activePorts: PortInfo[] = [];
let scanInterval: ReturnType<typeof setInterval> | null = null;
let ssAvailable: boolean | null = null;

// Ports to exclude from detection (Codeck itself + common system services).
// With network_mode: host, ss sees all host ports — filter out noise.
const CODECK_PORT = parseInt(process.env.CODECK_PORT || '80', 10);
const EXCLUDED_PORTS = new Set([22, 53, CODECK_PORT, 443, 631, 5353, 8080]);

function scanPorts(): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('ss', ['-tlnp'], (err, stdout) => {
      if (err) {
        if (ssAvailable === null) {
          ssAvailable = false;
          console.warn('[Ports] ss command not available — port scanning disabled');
        }
        resolve([]);
        return;
      }
      if (ssAvailable === null) ssAvailable = true;
      const ports: number[] = [];
      for (const line of stdout.split('\n')) {
        // Match lines like: LISTEN  0  128  *:3000  *:*
        const match = line.match(/:(\d+)\s/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (!EXCLUDED_PORTS.has(port) && port > 0 && port <= 65535 && !ports.includes(port)) {
            ports.push(port);
          }
        }
      }
      resolve(ports.sort((a, b) => a - b));
    });
  });
}

export function getActivePorts(): PortInfo[] {
  return activePorts;
}

export function startPortScanner(): void {
  if (scanInterval) return;

  // Initial scan
  scanPorts().then(ports => {
    activePorts = ports.map(p => ({ port: p, exposed: isPortExposed(p) }));
    broadcast({ type: 'ports', data: activePorts });
  });

  scanInterval = setInterval(async () => {
    const ports = await scanPorts();
    const newPorts = ports.map(p => ({ port: p, exposed: isPortExposed(p) }));
    const changed = newPorts.length !== activePorts.length ||
      newPorts.some((p, i) => p.port !== activePorts[i]?.port || p.exposed !== activePorts[i]?.exposed);
    if (changed) {
      activePorts = newPorts;
      broadcast({ type: 'ports', data: activePorts });
    }
  }, 5000);
}

export function stopPortScanner(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}
