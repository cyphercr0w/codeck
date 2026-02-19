// Per-IP sliding window rate limiter with env var configuration.

export interface RateLimiterConfig {
  /** Max requests per window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

interface Entry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly map = new Map<string, Entry>();
  private readonly config: RateLimiterConfig;
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    // Cleanup stale entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.map) {
        if (now - entry.windowStart > this.config.windowMs * 2) this.map.delete(key);
      }
    }, 5 * 60_000);
    this.cleanupInterval.unref();
  }

  /** Returns true if the request is allowed, false if rate limited. */
  check(key: string): boolean {
    const now = Date.now();
    const entry = this.map.get(key);
    if (!entry || now - entry.windowStart > this.config.windowMs) {
      this.map.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= this.config.max;
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.map.clear();
  }
}

// ── Factory with env var defaults ──

function envInt(name: string, fallback: number): number {
  const val = process.env[name];
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * Auth rate limiter — aggressive.
 * Env: RATE_AUTH_MAX (default 10), RATE_AUTH_WINDOW_MS (default 60000)
 */
export function createAuthLimiter(): RateLimiter {
  return new RateLimiter({
    max: envInt('RATE_AUTH_MAX', 10),
    windowMs: envInt('RATE_AUTH_WINDOW_MS', 60_000),
  });
}

/**
 * Writes rate limiter — moderate.
 * Applies to POST/PUT/DELETE on protected API routes.
 * Env: RATE_WRITES_MAX (default 60), RATE_WRITES_WINDOW_MS (default 60000)
 */
export function createWritesLimiter(): RateLimiter {
  return new RateLimiter({
    max: envInt('RATE_WRITES_MAX', 60),
    windowMs: envInt('RATE_WRITES_WINDOW_MS', 60_000),
  });
}

// ── Brute-force lockout (separate mechanism) ──
// Env: LOCKOUT_THRESHOLD (default 5), LOCKOUT_DURATION_MS (default 900000 = 15 min)

const LOCKOUT_THRESHOLD = envInt('LOCKOUT_THRESHOLD', 5);
const LOCKOUT_DURATION_MS = envInt('LOCKOUT_DURATION_MS', 15 * 60_000);

interface LockoutEntry {
  count: number;
  lockedUntil: number;
}

const lockoutMap = new Map<string, LockoutEntry>();

export function checkLockout(ip: string): { locked: boolean; retryAfter?: number } {
  const entry = lockoutMap.get(ip);
  if (!entry) return { locked: false };
  if (entry.lockedUntil > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  }
  if (entry.lockedUntil > 0) {
    lockoutMap.delete(ip);
  }
  return { locked: false };
}

export function recordFailedLogin(ip: string): void {
  const entry = lockoutMap.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= LOCKOUT_THRESHOLD) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    entry.count = 0;
  }
  lockoutMap.set(ip, entry);
}

export function clearFailedAttempts(ip: string): void {
  lockoutMap.delete(ip);
}
