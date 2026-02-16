import { existsSync } from 'fs';

/**
 * Detect if the Docker socket is mounted (experimental mode).
 * Returns true when /var/run/docker.sock exists inside the container.
 */
export function detectDockerSocketMount(): boolean {
  return existsSync('/var/run/docker.sock');
}

export type DeploymentMode = 'systemd' | 'docker' | 'cli-local';

/**
 * Detect the current deployment mode.
 * - systemd: running as a systemd service (SYSTEMD_EXEC_PID env var present)
 * - docker: running inside a Docker container (/.dockerenv exists)
 * - cli-local: running locally via CLI (default fallback)
 */
export function detectDeploymentMode(): DeploymentMode {
  if (process.env.SYSTEMD_EXEC_PID) {
    return 'systemd';
  }
  if (existsSync('/.dockerenv')) {
    return 'docker';
  }
  return 'cli-local';
}

export interface DefaultConfig {
  workspace: string;
  port: number;
}

/**
 * Get default configuration values based on deployment mode.
 */
export function getDefaultConfig(mode: DeploymentMode): DefaultConfig {
  switch (mode) {
    case 'systemd':
      return { workspace: '/home/codeck/workspace', port: 80 };
    case 'docker':
      return { workspace: '/workspace', port: 80 };
    case 'cli-local':
      return { workspace: process.cwd(), port: 3000 };
  }
}
