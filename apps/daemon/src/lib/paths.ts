import { join } from 'path';
import { platform, homedir } from 'os';

/**
 * Cross-platform CODECK_DIR resolution.
 *
 * Priority:
 *   1. CODECK_DIR env var (always used inside containers)
 *   2. OS-appropriate default for host (managed mode):
 *      - Linux/macOS: ~/.config/codeck
 *      - Windows: %APPDATA%\codeck
 */
function resolveCodeckDir(): string {
  if (process.env.CODECK_DIR) {
    return process.env.CODECK_DIR;
  }

  const os = platform();
  if (os === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'codeck');
  }
  // Linux and macOS
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'codeck');
}

export const CODECK_DIR = resolveCodeckDir();
