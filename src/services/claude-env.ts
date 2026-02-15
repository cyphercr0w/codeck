import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { ACTIVE_AGENT } from './agent.js';
import { readCredentials } from './auth-anthropic.js';

// Resolve agent binary path — re-resolves if cached path becomes invalid
let agentBinaryPath: string = ACTIVE_AGENT.command;

export function resolveAgentBinary(): string {
  // Use execFileSync to avoid shell injection — arguments are passed as array
  for (const locator of ['which', 'where']) {
    try {
      const result = execFileSync(locator, [ACTIVE_AGENT.command], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0].trim();
      if (result && existsSync(result)) {
        return result;
      }
    } catch { /* try next */ }
  }
  const commonPaths = [
    `/usr/local/bin/${ACTIVE_AGENT.command}`,
    `/usr/bin/${ACTIVE_AGENT.command}`,
    `/root/.npm-global/bin/${ACTIVE_AGENT.command}`,
  ];
  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }
  return ACTIVE_AGENT.command;
}

export function getValidAgentBinary(): string {
  if (existsSync(agentBinaryPath)) return agentBinaryPath;
  console.log(`[claude-env] Agent binary missing at ${agentBinaryPath}, re-resolving...`);
  agentBinaryPath = resolveAgentBinary();
  console.log(`[claude-env] Agent binary re-resolved: ${agentBinaryPath}`);
  return agentBinaryPath;
}

// Initialize on module load
agentBinaryPath = resolveAgentBinary();

export function getAgentBinaryPath(): string {
  return agentBinaryPath;
}

export function setAgentBinaryPath(path: string): void {
  agentBinaryPath = path;
}

export function getOAuthEnv(): Record<string, string> {
  const env: Record<string, string> = { HOME: '/root' };
  try {
    const creds = readCredentials();
    if (creds?.claudeAiOauth?.accessToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeAiOauth.accessToken;
    }
  } catch (e) {
    console.warn('[claude-env] Could not read OAuth credentials:', (e as Error).message);
  }
  return env;
}

export function ensureOnboardingComplete(): void {
  const configPath = ACTIVE_AGENT.configFile;
  try {
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    }
    let changed = false;
    if (!config.hasCompletedOnboarding) { config.hasCompletedOnboarding = true; changed = true; }
    if (!config.hasTrustDialogAccepted) { config.hasTrustDialogAccepted = true; changed = true; }
    if (!config.theme) { config.theme = 'dark'; changed = true; }
    if (changed) {
      const content = JSON.stringify(config, null, 2);
      writeFileSync(configPath, content, { mode: 0o600 });
      // Verify write succeeded
      const written = readFileSync(configPath, 'utf8');
      if (written !== content) {
        console.error('[claude-env] Config write verification failed — content mismatch');
      } else {
        console.log('[claude-env] Set hasCompletedOnboarding=true, hasTrustDialogAccepted=true, theme=dark');
      }
    }
  } catch (e) {
    console.error('[claude-env] Failed to update .claude.json:', (e as Error).message);
  }
}

// Blocklist of sensitive env vars that must never leak to child PTY processes.
// Codeck is a single-user sandbox — blocklist is the right approach here.
// An allowlist would break custom user env vars, DBUS, keyring, etc.
const BLOCKED_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GIT_TOKEN',
  'NODE_ENV', 'PORT',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'DATABASE_URL', 'REDIS_URL',
  'STRIPE_SECRET_KEY',
  'SENDGRID_API_KEY',
  'TWILIO_AUTH_TOKEN',
]);

const MAX_ENV_VALUE_LENGTH = 10_000;

export function buildCleanEnv(): Record<string, string> {
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || BLOCKED_ENV_VARS.has(key)) continue;
    cleanEnv[key] = value.length > MAX_ENV_VALUE_LENGTH
      ? (console.warn(`[claude-env] Truncating oversized env var ${key} (${value.length} bytes)`), value.slice(0, MAX_ENV_VALUE_LENGTH))
      : value;
  }
  return cleanEnv;
}
