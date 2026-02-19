import net from 'node:net';
import { execa } from 'execa';

/** Default timeout for Docker detection commands (ms) */
const DETECT_TIMEOUT = 15_000; // 15 seconds

export type OS = 'windows' | 'macos' | 'linux';

export function detectOS(): OS {
  switch (process.platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'macos';
    default: return 'linux';
  }
}

export async function isDockerInstalled(): Promise<boolean> {
  try {
    await execa('docker', ['--version'], { timeout: DETECT_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

export async function isDockerRunning(): Promise<boolean> {
  try {
    await execa('docker', ['info'], { timeout: DETECT_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

export async function getDockerComposeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execa('docker', ['compose', 'version', '--short'], { timeout: DETECT_TIMEOUT });
    return String(stdout ?? '').trim() || null;
  } catch {
    return null;
  }
}

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

export async function isBaseImageBuilt(): Promise<boolean> {
  try {
    await execa('docker', ['image', 'inspect', 'codeck-base'], { timeout: DETECT_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

export interface ContainerInfo {
  name: string;
  state: string;
  status: string;
  ports: string;
}

export async function getContainerStatus(projectPath: string, mode?: 'isolated' | 'managed'): Promise<ContainerInfo[]> {
  try {
    const composeFile = mode === 'managed' ? 'docker/compose.managed.yml' : 'docker/compose.isolated.yml';
    const { stdout } = await execa('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json'], {
      cwd: projectPath,
      timeout: DETECT_TIMEOUT,
    });
    const out = String(stdout ?? '').trim();
    if (!out) return [];

    // Docker Compose v2.21+ outputs a JSON array; older outputs one object per line
    let objects: Record<string, unknown>[];
    if (out.startsWith('[')) {
      objects = JSON.parse(out);
    } else {
      objects = out.split('\n').map(line => JSON.parse(line));
    }

    return objects.map(obj => ({
      name: String(obj.Name || obj.name || ''),
      state: String(obj.State || obj.state || ''),
      status: String(obj.Status || obj.status || ''),
      ports: String(obj.Ports || obj.ports || ''),
    }));
  } catch {
    return [];
  }
}

export function isNodeVersionOk(): boolean {
  const [major] = process.versions.node.split('.').map(Number);
  return major >= 20;
}
