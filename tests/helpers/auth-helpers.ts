/**
 * Test helpers for authentication testing
 */

export interface MockSession {
  token: string;
  createdAt: number;
}

/**
 * Generate a mock session token
 */
export function generateMockToken(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

/**
 * Create a mock session
 */
export function createMockSession(): MockSession {
  return {
    token: generateMockToken(),
    createdAt: Date.now(),
  };
}

/**
 * Create an expired session (for testing expiration)
 */
export function createExpiredSession(): MockSession {
  return {
    token: generateMockToken(),
    createdAt: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days ago
  };
}

/**
 * Create mock OAuth credentials
 */
export function createMockOAuthToken() {
  return {
    access_token: 'sk-ant-oat01-' + generateMockToken(),
    token_type: 'bearer',
    expires_in: 86400,
    expires_at: Date.now() + 86400000,
  };
}
