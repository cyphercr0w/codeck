import { markTokenExpired, getCachedOAuthToken, readCredentials, isRealToken, getInMemoryToken } from './auth-anthropic.js';
import { broadcastStatus } from '../web/websocket.js';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL = 60000; // 60 seconds

interface ClaudeUsage {
  available: boolean;
  fiveHour: {
    utilization: number;
    percent: number;
    resetsAt: string | null;
  } | null;
  sevenDay: {
    utilization: number;
    percent: number;
    resetsAt: string | null;
  } | null;
}

let usageCache: { data: ClaudeUsage; fetchedAt: number } | null = null;

function getOAuthToken(): string | null {
  // Priority 0: in-memory token (authoritative — survives file deletions)
  const memToken = getInMemoryToken();
  if (memToken && isRealToken(memToken)) {
    return memToken;
  }

  // Priority 1: plaintext cache (most reliable — survives CLI overwrites)
  const cached = getCachedOAuthToken();
  if (cached && isRealToken(cached)) {
    return cached;
  }

  // Priority 2: env var
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN && isRealToken(process.env.CLAUDE_CODE_OAUTH_TOKEN)) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // Priority 3: credentials file (may have mock token from CLI)
  try {
    const creds = readCredentials();
    const token = creds?.claudeAiOauth?.accessToken;
    if (token && isRealToken(token)) {
      return token;
    }
  } catch { /* ignore */ }

  return null;
}

export async function getClaudeUsage(): Promise<ClaudeUsage> {
  // Return cached data if fresh
  if (usageCache && (Date.now() - usageCache.fetchedAt) < CACHE_TTL) {
    return usageCache.data;
  }

  const token = getOAuthToken();
  if (!token) {
    return { available: false, fiveHour: null, sevenDay: null };
  }

  try {
    const res = await fetch(USAGE_API_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.log(`[ClaudeUsage] API returned ${res.status}`);
      if (res.status === 401) {
        markTokenExpired();
        broadcastStatus();
      }
      return { available: false, fiveHour: null, sevenDay: null };
    }

    const data = await res.json();

    const usage: ClaudeUsage = {
      available: true,
      fiveHour: data.five_hour ? {
        utilization: data.five_hour.utilization || 0,
        percent: Math.round(data.five_hour.utilization || 0),
        resetsAt: data.five_hour.resets_at || null,
      } : null,
      sevenDay: data.seven_day ? {
        utilization: data.seven_day.utilization || 0,
        percent: Math.round(data.seven_day.utilization || 0),
        resetsAt: data.seven_day.resets_at || null,
      } : null,
    };

    usageCache = { data: usage, fetchedAt: Date.now() };
    return usage;
  } catch (err) {
    console.log('[ClaudeUsage] Error fetching usage:', (err as Error).message);
    return { available: false, fiveHour: null, sevenDay: null };
  }
}
