import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

type NetworkMode = 'bridge';

let codeckPort = parseInt(process.env.CODECK_PORT || '80', 10);
const networkMode: NetworkMode = 'bridge';
let mappedPorts: Set<number> = new Set();
let containerId: string | null = null;

// Compose project info (detected from container labels via Docker API)
let composeProjectDir: string | null = null;
let composeProjectName: string | null = null;
let composeServiceName: string | null = null;
let containerImage: string | null = null;

const MAX_PORT_RANGE_SIZE = 100;

function parsePorts(spec: string): Set<number> {
  const result = new Set<number>();
  if (!spec.trim()) return result;
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (end - start + 1 > MAX_PORT_RANGE_SIZE) {
        console.warn(`[PortManager] Skipping oversized port range ${start}-${end} (max ${MAX_PORT_RANGE_SIZE})`);
        continue;
      }
      for (let i = start; i <= end; i++) {
        if (i > 0 && i <= 65535) result.add(i);
      }
    } else {
      const port = parseInt(trimmed, 10);
      if (port > 0 && port <= 65535) result.add(port);
    }
  }
  return result;
}

function detectContainerId(): string | null {
  // Try HOSTNAME env (Docker sets this to container ID by default)
  const hostname = process.env.HOSTNAME;
  if (hostname && /^[0-9a-f]{12,64}$/.test(hostname)) return hostname;

  // Try /proc/self/cgroup (Linux containers)
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    const match = cgroup.match(/\/docker\/([0-9a-f]{12,64})/);
    if (match) return match[1].slice(0, 12);
  } catch { /* not in a container or no access */ }

  return null;
}

/** Validate a string from Docker labels — only allow safe path/image characters */
function isValidPath(p: string): boolean {
  return /^[a-zA-Z]:\\[\w\\.\- /]+$/.test(p) || /^\/[\w.\- /]+$/.test(p);
}
function isValidImageName(img: string): boolean {
  return /^[\w.\-/:@]+$/.test(img);
}
function isValidComposeName(name: string): boolean {
  return /^[\w.\-]+$/.test(name);
}

function detectComposeInfo(): void {
  if (!containerId) return;
  try {
    const format = [
      '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
      '{{index .Config.Labels "com.docker.compose.project"}}',
      '{{index .Config.Labels "com.docker.compose.service"}}',
      '{{.Config.Image}}',
    ].join('||');
    const raw = execFileSync('docker', ['inspect', '--format', format, containerId], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const [dir, project, service, image] = raw.split('||');
    if (dir && dir !== '<no value>' && isValidPath(dir)) composeProjectDir = dir;
    if (project && project !== '<no value>' && isValidComposeName(project)) composeProjectName = project;
    if (service && service !== '<no value>' && isValidComposeName(service)) composeServiceName = service;
    if (image && image !== '<no value>' && isValidImageName(image)) containerImage = image;
    console.log(`[PortManager] compose: dir=${composeProjectDir}, project=${composeProjectName}, service=${composeServiceName}, image=${containerImage}`);
  } catch (e) {
    console.log(`[PortManager] Could not detect compose info: ${(e as Error).message}`);
  }
}

export function initPortManager(): void {
  const portsSpec = process.env.CODECK_MAPPED_PORTS || '';
  mappedPorts = parsePorts(portsSpec);

  containerId = detectContainerId();
  detectComposeInfo();

  console.log(`[PortManager] mode=bridge, mapped=${mappedPorts.size} ports, container=${containerId || 'unknown'}`);
}

export function getNetworkMode(): NetworkMode {
  return networkMode;
}

export function getMappedPorts(): number[] {
  return Array.from(mappedPorts).sort((a, b) => a - b);
}

export function isPortExposed(port: number): boolean {
  return mappedPorts.has(port);
}

export function getCodeckPort(): number {
  return codeckPort;
}

export function getNetworkInfo(): { mode: NetworkMode; mappedPorts: number[]; containerId: string | null; codeckPort: number } {
  return {
    mode: networkMode,
    mappedPorts: getMappedPorts(),
    containerId,
    codeckPort,
  };
}

export function getComposeInfo(): { projectDir: string | null; serviceName: string | null; image: string | null } {
  return { projectDir: composeProjectDir, serviceName: composeServiceName, image: containerImage };
}

export function addMappedPort(port: number): void {
  mappedPorts.add(port);
}

export function removeMappedPort(port: number): void {
  mappedPorts.delete(port);
}

/**
 * Write docker-compose.override.yml on the host filesystem via a helper container.
 * Uses the sandbox image (already local) with entrypoint override.
 * The override adds port mappings and updates CODECK_MAPPED_PORTS env var.
 *
 * If no extra ports remain (only port 80), deletes the override file.
 */
export function writePortOverride(ports: number[]): void {
  if (!composeProjectDir || !composeServiceName || !containerImage) {
    throw new Error('Compose project info not available');
  }

  const allPorts = new Set(ports);
  allPorts.add(codeckPort); // Always keep the Codeck port

  // Override ports = everything except the Codeck port (which is in the base compose file)
  const overridePorts = Array.from(allPorts).filter(p => p !== codeckPort).sort((a, b) => a - b);
  const allPortsList = Array.from(allPorts).sort((a, b) => a - b);

  if (overridePorts.length === 0) {
    // No extra ports — remove override file so compose uses base only
    deletePortOverride();
    return;
  }

  const portLines = overridePorts.map(p => `      - "${p}:${p}"`).join('\n');
  const yaml = [
    'services:',
    `  ${composeServiceName}:`,
    '    ports:',
    portLines,
    '    environment:',
    `      - CODECK_MAPPED_PORTS=${allPortsList.join(',')}`,
    '',
  ].join('\n');

  // Write via stdin pipe using execFileSync input option (no shell)
  const b64 = Buffer.from(yaml).toString('base64');
  execFileSync('docker', [
    'run', '--rm', '-i',
    '-v', `${composeProjectDir}:/compose`,
    '--entrypoint', 'sh',
    containerImage,
    '-c', 'base64 -d > /compose/docker-compose.override.yml',
  ], { input: b64, encoding: 'utf8', timeout: 30000 });

  console.log(`[PortManager] Wrote override: ports=[${overridePorts.join(',')}], env=CODECK_MAPPED_PORTS=${allPortsList.join(',')}`);
}

/**
 * Delete docker-compose.override.yml on the host filesystem via a helper container.
 * Used when all extra port mappings are removed.
 */
export function deletePortOverride(): void {
  if (!composeProjectDir || !containerImage) {
    throw new Error('Compose project info not available');
  }

  execFileSync('docker', [
    'run', '--rm',
    '-v', `${composeProjectDir}:/compose`,
    '--entrypoint', 'sh',
    containerImage,
    '-c', 'rm -f /compose/docker-compose.override.yml',
  ], { encoding: 'utf8', timeout: 15000 });

  console.log('[PortManager] Deleted override file (no extra ports)');
}

/**
 * Spawn a detached helper container that runs `docker compose up -d` after a delay.
 * This recreates the sandbox container with the updated port mappings from the override file.
 * The helper runs independently — it survives the sandbox container being stopped.
 *
 * The compose project dir is a host path (may be Windows-style on Docker Desktop).
 * We mount it at /compose inside the helper and use -p to specify the compose project name.
 */
export function spawnComposeRestart(): void {
  if (!composeProjectDir || !containerImage || !composeProjectName) {
    throw new Error('Compose project info not available');
  }

  // Inherit DOCKER_HOST from parent env instead of re-mounting the socket directly.
  // This ensures the helper respects a Docker socket proxy if one is deployed.
  const dockerHost = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  const dockerArgs = [
    'run', '-d', '--rm',
    '-e', `DOCKER_HOST=${dockerHost}`,
    '-v', `${composeProjectDir}:/compose`,
    '-w', '/compose',
    '--entrypoint', 'sh',
    containerImage!,
    '-c', `sleep 3 && docker compose -p ${composeProjectName} up -d`,
  ];
  // If using default unix socket, mount it (required for the helper to reach the daemon)
  if (dockerHost.startsWith('unix://')) {
    const socketPath = dockerHost.replace('unix://', '');
    dockerArgs.splice(3, 0, '-v', `${socketPath}:${socketPath}`);
  }
  execFileSync('docker', dockerArgs, { encoding: 'utf8', timeout: 15000 });

  console.log('[PortManager] Spawned restart helper container');
}

/**
 * Check if the system can perform automatic port exposure (has compose info + Docker access).
 */
export function canAutoRestart(): boolean {
  return !!(composeProjectDir && composeProjectName && composeServiceName && containerImage);
}
