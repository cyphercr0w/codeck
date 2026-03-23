/**
 * Generic CLI-based OAuth device flow for third-party services.
 * Spawns a CLI login process, captures the device code + URL from stdout,
 * and tracks completion state for the frontend to poll.
 */
import { spawn, type ChildProcess } from 'child_process';

export interface CLIAuthState {
  inProgress: boolean;
  code: string | null;
  url: string | null;
  success: boolean;
  error: string | null;
}

interface CLIAuthConfig {
  /** npx package or binary to run */
  command: string;
  /** Arguments for the login command */
  args: string[];
  /** Regex to extract the device URL from output */
  urlPattern: RegExp;
  /** Optional regex to extract a user-facing code */
  codePattern?: RegExp;
  /** Regex that indicates successful auth */
  successPattern: RegExp;
  /** Timeout in ms */
  timeout?: number;
}

const CONFIGS: Record<string, CLIAuthConfig> = {
  vercel: {
    command: 'npx',
    args: ['-y', 'vercel', 'login', '--non-interactive'],
    urlPattern: /https:\/\/vercel\.com\/oauth\/device\S*/,
    codePattern: /user_code=([A-Z0-9-]+)/,
    successPattern: /Congratulations|Success|Authenticated|logged in/i,
    timeout: 120_000,
  },
};

const activeLogins = new Map<string, { state: CLIAuthState; proc: ChildProcess | null }>();

export function isValidService(service: string): boolean {
  return service in CONFIGS;
}

export function getAuthState(service: string): CLIAuthState {
  return activeLogins.get(service)?.state ?? {
    inProgress: false, code: null, url: null, success: false, error: null,
  };
}

export function startCLIAuth(service: string, onUpdate?: () => void): CLIAuthState {
  const config = CONFIGS[service];
  if (!config) {
    return { inProgress: false, code: null, url: null, success: false, error: 'Unsupported service' };
  }

  const existing = activeLogins.get(service);
  if (existing?.state.inProgress) return existing.state;

  const state: CLIAuthState = { inProgress: true, code: null, url: null, success: false, error: null };

  // Reserve the slot immediately to prevent double-spawn from concurrent requests
  activeLogins.set(service, { state, proc: null });

  let proc: ChildProcess;
  try {
    proc = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    state.inProgress = false;
    state.error = 'Failed to start CLI';
    activeLogins.delete(service);
    return state;
  }

  activeLogins.set(service, { state, proc });

  // Explicit timeout — kill process and clean up with a clear message
  const timeoutMs = config.timeout ?? 120_000;
  const killTimer = setTimeout(() => {
    if (state.inProgress) {
      proc.kill();
      state.inProgress = false;
      state.error = 'Login timed out';
      activeLogins.delete(service);
      onUpdate?.();
    }
  }, timeoutMs);

  function handleOutput(data: Buffer) {
    const text = data.toString();

    const urlMatch = text.match(config.urlPattern);
    if (urlMatch) {
      state.url = urlMatch[0];
      if (config.codePattern) {
        const codeMatch = state.url.match(config.codePattern);
        if (codeMatch) state.code = codeMatch[1];
      }
      onUpdate?.();
    }

    if (config.successPattern.test(text)) {
      state.success = true;
      state.inProgress = false;
      onUpdate?.();
    }
  }

  proc.stdout?.on('data', handleOutput);
  proc.stderr?.on('data', handleOutput);

  proc.on('close', (exitCode) => {
    clearTimeout(killTimer);
    state.inProgress = false;
    if (exitCode === 0) state.success = true;
    else if (!state.success) state.error = state.error ?? `CLI exited with code ${exitCode ?? 'unknown'}`;
    activeLogins.delete(service);
    onUpdate?.();
  });

  proc.on('error', (err) => {
    clearTimeout(killTimer);
    state.inProgress = false;
    state.error = err.message;
    activeLogins.delete(service);
    onUpdate?.();
  });

  // Send a newline to stdin to trigger the flow (some CLIs wait for input)
  proc.stdin?.write('\n');

  return state;
}

export function cancelCLIAuth(service: string): void {
  const entry = activeLogins.get(service);
  if (entry?.proc) {
    entry.proc.kill();
    entry.state.inProgress = false;
    entry.state.error = 'Cancelled';
  }
  activeLogins.delete(service);
}

export function getSupportedCLIAuthServices(): string[] {
  return Object.keys(CONFIGS);
}
