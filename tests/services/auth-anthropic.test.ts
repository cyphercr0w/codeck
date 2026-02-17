import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

// Use env var from tests/setup.ts (points to /tmp/codeck-test/.claude)
const CLAUDE_CONFIG_PATH = process.env.CLAUDE_CONFIG_DIR || '/root/.claude';
const PKCE_STATE_PATH = join(CLAUDE_CONFIG_PATH, '.pkce-state.json');
const CREDENTIALS_PATH = join(CLAUDE_CONFIG_PATH, '.credentials.json');
const TOKEN_CACHE_PATH = join(CLAUDE_CONFIG_PATH, '.codeck-oauth-token');
const ACCOUNT_CACHE_PATH = join(CLAUDE_CONFIG_PATH, '.codeck-account-info.json');
const CREDENTIALS_BACKUP = join(CLAUDE_CONFIG_PATH, '.codeck-credentials-backup.json');

describe('auth-anthropic.ts - OAuth Flow', () => {
  beforeEach(async () => {
    // Ensure config directory exists
    if (!existsSync(CLAUDE_CONFIG_PATH)) {
      mkdirSync(CLAUDE_CONFIG_PATH, { recursive: true, mode: 0o700 });
    }

    // Clean up any existing state from previous tests
    for (const f of [PKCE_STATE_PATH, CREDENTIALS_PATH, TOKEN_CACHE_PATH, ACCOUNT_CACHE_PATH, CREDENTIALS_BACKUP]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }

    // Reset login state and in-memory token from previous tests
    const { cancelLogin, _resetInMemoryTokenForTesting, invalidateAuthCache } = await import('../../src/services/auth-anthropic.js');
    _resetInMemoryTokenForTesting();
    invalidateAuthCache();
    cancelLogin();
  });

  afterEach(() => {
    // Cleanup test artifacts
    for (const f of [PKCE_STATE_PATH, CREDENTIALS_PATH, TOKEN_CACHE_PATH, ACCOUNT_CACHE_PATH, CREDENTIALS_BACKUP]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }
  });

  describe('startClaudeLogin - PKCE Generation', () => {
    it('should generate PKCE code verifier (base64url, 32 bytes)', async () => {
      // Import service
      const { startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

      // Start login to trigger PKCE generation
      const result = await startClaudeLogin();

      // Verify login started
      expect(result.started).toBe(true);
      expect(result.url).toBeDefined();
      expect(typeof result.url).toBe('string');

      // Verify PKCE state file was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);

      // Read PKCE state file
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));

      // Verify code verifier exists and is a string
      expect(pkceState.codeVerifier).toBeDefined();
      expect(typeof pkceState.codeVerifier).toBe('string');

      // Verify code verifier is base64url encoded (43 chars for 32 bytes without padding)
      // 32 bytes * 8 bits/byte = 256 bits
      // base64 encoding: 256 / 6 = 42.67 → rounds to 43 chars
      expect(pkceState.codeVerifier.length).toBe(43);

      // Verify base64url format (only alphanumeric, - and _, no padding =)
      expect(pkceState.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(pkceState.codeVerifier).not.toContain('=');
      expect(pkceState.codeVerifier).not.toContain('+');
      expect(pkceState.codeVerifier).not.toContain('/');

      // Verify it uses randomBytes by checking entropy (simple heuristic)
      // A cryptographically random 43-char base64url string should have decent character diversity
      const uniqueChars = new Set(pkceState.codeVerifier).size;
      expect(uniqueChars).toBeGreaterThan(20); // Should have >20 unique characters out of 43

      // Verify the URL contains the code_challenge derived from this verifier
      expect(result.url).toContain('code_challenge=');
      expect(result.url).toContain('code_challenge_method=S256');
    });

    it('should generate code challenge (SHA-256 of verifier)', async () => {
      // Import crypto for manual verification
      const { createHash } = await import('crypto');
      const { startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

      // Start login to trigger PKCE generation
      const result = await startClaudeLogin();

      // Verify login started
      expect(result.started).toBe(true);
      expect(result.url).toBeDefined();

      // Read PKCE state file
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));

      // Verify code verifier exists (code challenge is NOT stored, computed on-the-fly)
      expect(pkceState.codeVerifier).toBeDefined();
      expect(typeof pkceState.codeVerifier).toBe('string');

      // Manually compute the code challenge from the verifier
      // PKCE spec: code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
      const computedChallenge = createHash('sha256')
        .update(pkceState.codeVerifier)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''); // Remove padding

      // Verify code challenge is base64url encoded (43 chars for 32-byte SHA-256 hash)
      // SHA-256 produces 32 bytes → 256 bits → base64 encodes to 43 chars (without padding)
      expect(computedChallenge.length).toBe(43);
      expect(computedChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(computedChallenge).not.toContain('=');
      expect(computedChallenge).not.toContain('+');
      expect(computedChallenge).not.toContain('/');

      // Verify the OAuth URL includes the computed code challenge
      expect(result.url).toContain(`code_challenge=${computedChallenge}`);
      expect(result.url).toContain('code_challenge_method=S256');

      // Verify code challenge is deterministic (same verifier → same challenge)
      const secondChallenge = createHash('sha256')
        .update(pkceState.codeVerifier)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(secondChallenge).toBe(computedChallenge);
    });

    it('should generate random state for CSRF protection', async () => {
      // Import service
      const { startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

      // Start login to trigger state generation
      const result = await startClaudeLogin();

      // Verify login started
      expect(result.started).toBe(true);
      expect(result.url).toBeDefined();

      // Read PKCE state file
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));

      // Verify state exists and is a string
      expect(pkceState.state).toBeDefined();
      expect(typeof pkceState.state).toBe('string');

      // Verify state is base64url encoded (43 chars for 32 bytes without padding)
      // Same format as code verifier: 32 bytes * 8 bits/byte = 256 bits
      // base64 encoding: 256 / 6 = 42.67 → rounds to 43 chars
      expect(pkceState.state.length).toBe(43);

      // Verify base64url format (only alphanumeric, - and _, no padding =)
      expect(pkceState.state).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(pkceState.state).not.toContain('=');
      expect(pkceState.state).not.toContain('+');
      expect(pkceState.state).not.toContain('/');

      // Verify it uses randomBytes by checking entropy (simple heuristic)
      // A cryptographically random 43-char base64url string should have decent character diversity
      const uniqueChars = new Set(pkceState.state).size;
      expect(uniqueChars).toBeGreaterThan(20); // Should have >20 unique characters out of 43

      // Verify state is different from code verifier (independent randomness)
      expect(pkceState.state).not.toBe(pkceState.codeVerifier);

      // Verify the OAuth URL includes the state parameter for CSRF protection
      expect(result.url).toContain(`state=${pkceState.state}`);

      // Test randomness by generating a second state
      const { cancelLogin } = await import('../../src/services/auth-anthropic.js');
      cancelLogin();
      if (existsSync(PKCE_STATE_PATH)) {
        rmSync(PKCE_STATE_PATH, { force: true });
      }

      const result2 = await startClaudeLogin();
      const pkceState2 = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));

      // Verify different login attempts generate different states
      expect(pkceState2.state).not.toBe(pkceState.state);
      expect(pkceState2.state.length).toBe(43);
      expect(pkceState2.state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should persist PKCE state to .pkce-state.json', async () => {
      // Import service and fs
      const { startClaudeLogin } = await import('../../src/services/auth-anthropic.js');
      const { statSync } = await import('fs');

      // Start login to trigger PKCE state persistence
      const result = await startClaudeLogin();

      // Verify login started
      expect(result.started).toBe(true);
      expect(result.url).toBeDefined();

      // Verify PKCE state file was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);

      // Verify file permissions are secure (0o600 = owner read/write only)
      const stat = statSync(PKCE_STATE_PATH);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);

      // Read and parse PKCE state file
      const pkceStateRaw = readFileSync(PKCE_STATE_PATH, 'utf-8');
      const pkceState = JSON.parse(pkceStateRaw);

      // Verify all required fields are persisted
      expect(pkceState).toBeDefined();
      expect(typeof pkceState).toBe('object');

      // Verify codeVerifier field
      expect(pkceState.codeVerifier).toBeDefined();
      expect(typeof pkceState.codeVerifier).toBe('string');
      expect(pkceState.codeVerifier.length).toBe(43);
      expect(pkceState.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify state field
      expect(pkceState.state).toBeDefined();
      expect(typeof pkceState.state).toBe('string');
      expect(pkceState.state.length).toBe(43);
      expect(pkceState.state).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify nonce field (also 43-char base64url)
      expect(pkceState.nonce).toBeDefined();
      expect(typeof pkceState.nonce).toBe('string');
      expect(pkceState.nonce.length).toBe(43);
      expect(pkceState.nonce).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify url field matches returned URL
      expect(pkceState.url).toBeDefined();
      expect(typeof pkceState.url).toBe('string');
      expect(pkceState.url).toBe(result.url);

      // Verify startedAt timestamp exists and is recent (within 5 seconds)
      expect(pkceState.startedAt).toBeDefined();
      expect(typeof pkceState.startedAt).toBe('number');
      expect(pkceState.startedAt).toBeGreaterThan(Date.now() - 5000);
      expect(pkceState.startedAt).toBeLessThanOrEqual(Date.now());

      // Verify JSON is valid and can be re-parsed (persistence test)
      const pkceStateReparsed = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
      expect(pkceStateReparsed).toEqual(pkceState);

      // Verify atomic write (file should not be corrupt if written mid-process)
      // The atomicWriteFileSync function writes to temp file then renames atomically
      // We can't directly test this without mocking, but we verify file integrity
      expect(() => JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'))).not.toThrow();
    });

    it('should return OAuth URL with correct parameters', async () => {
      // Import service
      const { startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

      // Start login to get OAuth URL
      const result = await startClaudeLogin();

      // Verify login started
      expect(result.started).toBe(true);
      expect(result.url).toBeDefined();
      expect(typeof result.url).toBe('string');

      // Parse URL to validate structure and parameters
      const url = new URL(result.url!);

      // Verify base URL is correct (https://claude.ai/oauth/authorize)
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('claude.ai');
      expect(url.pathname).toBe('/oauth/authorize');

      // Verify all required OAuth parameters are present
      const params = url.searchParams;

      // client_id - OAuth client ID from Claude CLI
      expect(params.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');

      // code=true - indicates authorization code flow
      expect(params.get('code')).toBe('true');

      // response_type=code - standard OAuth 2.0 authorization code grant
      expect(params.get('response_type')).toBe('code');

      // redirect_uri - where Claude will redirect after auth
      expect(params.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');

      // scope - requested permissions
      expect(params.get('scope')).toBe('user:inference user:profile');

      // code_challenge - PKCE challenge (base64url, 43 chars)
      const codeChallenge = params.get('code_challenge');
      expect(codeChallenge).toBeDefined();
      expect(codeChallenge).not.toBeNull();
      expect(codeChallenge!.length).toBe(43);
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

      // code_challenge_method - PKCE method (S256 = SHA-256)
      expect(params.get('code_challenge_method')).toBe('S256');

      // state - CSRF protection (base64url, 43 chars)
      const state = params.get('state');
      expect(state).toBeDefined();
      expect(state).not.toBeNull();
      expect(state!.length).toBe(43);
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);

      // nonce - replay attack prevention (base64url, 43 chars)
      const nonce = params.get('nonce');
      expect(nonce).toBeDefined();
      expect(nonce).not.toBeNull();
      expect(nonce!.length).toBe(43);
      expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify code_challenge, state, and nonce are all unique
      expect(codeChallenge).not.toBe(state);
      expect(codeChallenge).not.toBe(nonce);
      expect(state).not.toBe(nonce);

      // Read PKCE state file to verify URL matches persisted state
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
      expect(pkceState.url).toBe(result.url);
      expect(pkceState.state).toBe(state);
      expect(pkceState.nonce).toBe(nonce);
    });

    it('should reject if login already in progress', async () => {
      // Import service
      const { startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

      // Act 1 - Start first login
      const result1 = await startClaudeLogin();

      // Assert 1 - First login should succeed
      expect(result1.started).toBe(true);
      expect(result1.url).toBeDefined();
      expect(typeof result1.url).toBe('string');

      // Act 2 - Attempt to start second login while first is still in progress
      const result2 = await startClaudeLogin();

      // Assert 2 - Second login should be rejected with inProgress indicator
      expect(result2.started).toBe(false);
      expect(result2.message).toBeDefined();
      expect(typeof result2.message).toBe('string');

      // Message should indicate login is in progress
      // Could be either 'Login in progress' or 'Waiting for code' (both are valid)
      expect(result2.message).toMatch(/Login in progress|Waiting for code/);

      // URL should still be returned (the URL from the first login)
      expect(result2.url).toBeDefined();
      expect(result2.url).toBe(result1.url);

      // Verify PKCE state file still exists (not overwritten by second attempt)
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);

      // Read PKCE state and verify it matches the first login
      const pkceState1 = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));

      // Attempt third login to confirm rejection is consistent
      const result3 = await startClaudeLogin();
      expect(result3.started).toBe(false);
      expect(result3.message).toMatch(/Login in progress|Waiting for code/);
      expect(result3.url).toBe(result1.url);

      // Verify PKCE state unchanged (same codeVerifier, state, nonce from first login)
      const pkceState2 = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
      expect(pkceState2.codeVerifier).toBe(pkceState1.codeVerifier);
      expect(pkceState2.state).toBe(pkceState1.state);
      expect(pkceState2.nonce).toBe(pkceState1.nonce);
      expect(pkceState2.url).toBe(pkceState1.url);
      expect(pkceState2.startedAt).toBe(pkceState1.startedAt);

      // This test verifies:
      // 1. Second login attempt is rejected (started=false)
      // 2. Error message indicates login in progress
      // 3. Original URL is returned
      // 4. PKCE state is not overwritten (security: prevents PKCE confusion)
      // 5. Rejection is consistent across multiple attempts
    });

    it('should cleanup stale login (>5min old)', async () => {
      // Import service
      const { startClaudeLogin } = await import('../../src/services/auth-anthropic.js');

      // Setup fake timers to control time
      vi.useFakeTimers();

      try {
        // Arrange - Start login at time T
        const result1 = await startClaudeLogin();

        // Verify login started successfully
        expect(result1.started).toBe(true);
        expect(result1.url).toBeDefined();

        // Read the initial PKCE state (stored at time T)
        const initialState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
        expect(initialState.startedAt).toBeDefined();

        // Act - Advance time by 6 minutes (360,000ms > 5min timeout)
        // This makes the login stale
        vi.advanceTimersByTime(6 * 60 * 1000);

        // Start new login (should detect stale login and cleanup)
        const result2 = await startClaudeLogin();

        // Assert - New login should succeed (not rejected as "in progress")
        expect(result2.started).toBe(true);
        expect(result2.url).toBeDefined();
        expect(typeof result2.url).toBe('string');

        // Verify new URL is different from stale URL (new PKCE values generated)
        expect(result2.url).not.toBe(result1.url);

        // Read new PKCE state to verify it was regenerated
        const newState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));

        // Verify startedAt is current (at T+6min, which is the new "now")
        const currentFakeTime = Date.now();
        expect(newState.startedAt).toBeGreaterThanOrEqual(currentFakeTime - 1000);
        expect(newState.startedAt).toBeLessThanOrEqual(currentFakeTime);

        // Verify PKCE values are different (regenerated, not reused)
        expect(newState.codeVerifier).not.toBe(initialState.codeVerifier);
        expect(newState.state).not.toBe(initialState.state);
        expect(newState.nonce).not.toBe(initialState.nonce);
        expect(newState.url).toBe(result2.url);

        // Security check: Verify old PKCE values are no longer valid
        // (stale code_challenge should not match new URL)
        const oldCodeChallenge = new URL(result1.url!).searchParams.get('code_challenge');
        expect(result2.url).not.toContain(oldCodeChallenge!);
      } finally {
        // Cleanup - restore real timers
        vi.useRealTimers();
      }
    });
  });

  describe('sendLoginCode - Code Exchange', () => {
    it('should accept raw authorization code', async () => {
      // Import service
      const { startClaudeLogin, sendLoginCode } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Start OAuth login first to initialize PKCE state
      const loginResult = await startClaudeLogin();
      expect(loginResult.started).toBe(true);
      expect(loginResult.url).toBeDefined();

      // Verify PKCE state was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
      expect(pkceState.codeVerifier).toBeDefined();
      expect(pkceState.state).toBeDefined();

      // Mock the fetch function for OAuth token exchange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'sk-ant-oat01-mock-access-token-1234567890abcdef',
          refresh_token: 'sk-ant-oat01-mock-refresh-token-1234567890abcdef',
          expires_in: 31536000, // 1 year in seconds
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        // Act - Send raw authorization code (typical format from OAuth callback)
        const rawCode = 'mock_authorization_code_1234567890';
        const result = await sendLoginCode(rawCode);

        // Assert - Code exchange should succeed
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();

        // Verify fetch was called with correct parameters
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        expect(fetchCall[0]).toBe('https://platform.claude.com/v1/oauth/token');

        const fetchOptions = fetchCall[1] as RequestInit;
        expect(fetchOptions.method).toBe('POST');
        expect(fetchOptions.headers).toEqual({ 'Content-Type': 'application/json' });

        const requestBody = JSON.parse(fetchOptions.body as string);
        expect(requestBody.grant_type).toBe('authorization_code');
        expect(requestBody.code).toBe(rawCode);
        expect(requestBody.redirect_uri).toBe('https://platform.claude.com/oauth/code/callback');
        expect(requestBody.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
        expect(requestBody.code_verifier).toBe(pkceState.codeVerifier);
        expect(requestBody.state).toBe(pkceState.state);

        // Verify encrypted credentials file was created
        expect(existsSync(CREDENTIALS_PATH)).toBe(true);

        // Verify file has secure permissions (0o600)
        const { statSync } = await import('fs');
        const stat = statSync(CREDENTIALS_PATH);
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);

        // Verify credentials were saved with encryption
        const credentialsRaw = readFileSync(CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(credentialsRaw);

        // Verify v2 encrypted format
        expect(credentials.version).toBe(2);
        expect(credentials.claudeAiOauth).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.encrypted).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.iv).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.tag).toBeDefined();
        expect(credentials.claudeAiOauth.refreshToken).toBeDefined();
        expect(credentials.claudeAiOauth.refreshToken.encrypted).toBeDefined();
        expect(credentials.claudeAiOauth.expiresAt).toBeDefined();
        expect(credentials.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());

        // Verify tokens are encrypted (not plaintext)
        expect(credentials.claudeAiOauth.accessToken.encrypted).not.toContain('sk-ant-oat01');

        // Verify PKCE state was cleaned up after successful exchange
        expect(existsSync(PKCE_STATE_PATH)).toBe(false);
      } finally {
        // Cleanup - restore real fetch
        vi.unstubAllGlobals();
      }
    });

    it('should accept direct token (sk-ant-oat01-*)', async () => {
      // Import service
      const { sendLoginCode, isClaudeAuthenticated } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Direct token (bypasses OAuth flow)
      const directToken = 'sk-ant-oat01-direct-token-abcdef1234567890ABCDEF1234567890-xyz';

      // Act - Send direct token (no PKCE state needed)
      const result = await sendLoginCode(directToken);

      // Assert - Token should be saved successfully
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify credentials file was created
      expect(existsSync(CREDENTIALS_PATH)).toBe(true);

      // Verify file has secure permissions (0o600)
      const { statSync } = await import('fs');
      const stat = statSync(CREDENTIALS_PATH);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);

      // Verify credentials were saved with encryption
      const credentialsRaw = readFileSync(CREDENTIALS_PATH, 'utf-8');
      const credentials = JSON.parse(credentialsRaw);

      // Verify v2 encrypted format
      expect(credentials.version).toBe(2);
      expect(credentials.claudeAiOauth).toBeDefined();
      expect(credentials.claudeAiOauth.accessToken).toBeDefined();

      // Verify access token is encrypted (not plaintext)
      expect(credentials.claudeAiOauth.accessToken.encrypted).toBeDefined();
      expect(credentials.claudeAiOauth.accessToken.iv).toBeDefined();
      expect(credentials.claudeAiOauth.accessToken.tag).toBeDefined();
      expect(credentials.claudeAiOauth.accessToken.encrypted).not.toContain('sk-ant-oat01');

      // Verify no refresh token for direct token (only OAuth flow provides refresh tokens)
      // Direct tokens don't have refresh tokens, so the refreshToken field should be absent or null
      if (credentials.claudeAiOauth.refreshToken) {
        // If present, should be encrypted format but can be empty encrypted value
        expect(credentials.claudeAiOauth.refreshToken.encrypted).toBeDefined();
      }

      // Verify expiresAt is set (1 year from now for direct tokens)
      expect(credentials.claudeAiOauth.expiresAt).toBeDefined();
      expect(credentials.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
      // Should be approximately 1 year (31536000000ms) from now
      const oneYearFromNow = Date.now() + 31536000000;
      const expiryDelta = Math.abs(credentials.claudeAiOauth.expiresAt - oneYearFromNow);
      expect(expiryDelta).toBeLessThan(5000); // Within 5 seconds

      // Verify authentication check returns true
      expect(isClaudeAuthenticated()).toBe(true);

      // Verify PKCE state was cleaned up (if any existed)
      // Direct token flow doesn't require PKCE, so this should be false or file removed
      expect(existsSync(PKCE_STATE_PATH)).toBe(false);
    });

    it('should accept code with state (code#state)', async () => {
      // Import service
      const { startClaudeLogin, sendLoginCode } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Start OAuth login first to initialize PKCE state
      const loginResult = await startClaudeLogin();
      expect(loginResult.started).toBe(true);
      expect(loginResult.url).toBeDefined();

      // Verify PKCE state was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
      expect(pkceState.codeVerifier).toBeDefined();
      expect(pkceState.state).toBeDefined();

      // Mock the fetch function for OAuth token exchange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'sk-ant-oat01-mock-access-token-with-state-1234567890',
          refresh_token: 'sk-ant-oat01-mock-refresh-token-with-state-1234567890',
          expires_in: 31536000, // 1 year in seconds
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        // Act - Send code with state in "code#state" format (OAuth callback format)
        // This simulates pasting the code from the OAuth callback page
        const codeWithState = `mock_auth_code_12345#${pkceState.state}`;
        const result = await sendLoginCode(codeWithState);

        // Assert - Code exchange should succeed
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();

        // Verify fetch was called with correct parameters
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        expect(fetchCall[0]).toBe('https://platform.claude.com/v1/oauth/token');

        const fetchOptions = fetchCall[1] as RequestInit;
        expect(fetchOptions.method).toBe('POST');
        expect(fetchOptions.headers).toEqual({ 'Content-Type': 'application/json' });

        const requestBody = JSON.parse(fetchOptions.body as string);

        // Verify code was extracted correctly (without the #state part)
        expect(requestBody.code).toBe('mock_auth_code_12345');
        expect(requestBody.code).not.toContain('#');
        expect(requestBody.code).not.toContain(pkceState.state);

        // Verify PKCE parameters are correct
        expect(requestBody.grant_type).toBe('authorization_code');
        expect(requestBody.redirect_uri).toBe('https://platform.claude.com/oauth/code/callback');
        expect(requestBody.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
        expect(requestBody.code_verifier).toBe(pkceState.codeVerifier);
        expect(requestBody.state).toBe(pkceState.state);

        // Verify encrypted credentials file was created
        expect(existsSync(CREDENTIALS_PATH)).toBe(true);

        // Verify file has secure permissions (0o600)
        const { statSync } = await import('fs');
        const stat = statSync(CREDENTIALS_PATH);
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);

        // Verify credentials were saved with encryption
        const credentialsRaw = readFileSync(CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(credentialsRaw);

        // Verify v2 encrypted format
        expect(credentials.version).toBe(2);
        expect(credentials.claudeAiOauth).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.encrypted).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.iv).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.tag).toBeDefined();

        // Verify PKCE state was cleaned up after successful exchange
        expect(existsSync(PKCE_STATE_PATH)).toBe(false);
      } finally {
        // Cleanup - restore real fetch
        vi.unstubAllGlobals();
      }
    });

    it('should accept full URL with code parameter', async () => {
      // Import service
      const { startClaudeLogin, sendLoginCode } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Start OAuth login first to initialize PKCE state
      const loginResult = await startClaudeLogin();
      expect(loginResult.started).toBe(true);
      expect(loginResult.url).toBeDefined();

      // Verify PKCE state was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
      expect(pkceState.codeVerifier).toBeDefined();
      expect(pkceState.state).toBeDefined();

      // Mock the fetch function for OAuth token exchange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'sk-ant-oat01-mock-access-token-1234567890abcdef',
          refresh_token: 'sk-ant-oat01-mock-refresh-token-1234567890abcdef',
          expires_in: 31536000, // 1 year in seconds
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        // Act - Send full OAuth callback URL with code parameter
        // This simulates user pasting the full URL from the browser address bar
        const authCode = 'mock_authorization_code_from_url';
        const fullUrl = `https://platform.claude.com/oauth/code/callback?code=${authCode}&state=${pkceState.state}`;
        const result = await sendLoginCode(fullUrl);

        // Assert - Code extraction and exchange should succeed
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();

        // Verify fetch was called with correct parameters
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        expect(fetchCall[0]).toBe('https://platform.claude.com/v1/oauth/token');

        const fetchOptions = fetchCall[1] as RequestInit;
        expect(fetchOptions.method).toBe('POST');
        expect(fetchOptions.headers).toEqual({ 'Content-Type': 'application/json' });

        // Verify code was extracted from URL and sent correctly
        const requestBody = JSON.parse(fetchOptions.body as string);
        expect(requestBody.grant_type).toBe('authorization_code');
        expect(requestBody.code).toBe(authCode); // Extracted from URL
        expect(requestBody.redirect_uri).toBe('https://platform.claude.com/oauth/code/callback');
        expect(requestBody.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
        expect(requestBody.code_verifier).toBe(pkceState.codeVerifier);
        expect(requestBody.state).toBe(pkceState.state);

        // Verify encrypted credentials file was created
        expect(existsSync(CREDENTIALS_PATH)).toBe(true);

        // Verify file has secure permissions (0o600)
        const { statSync } = await import('fs');
        const stat = statSync(CREDENTIALS_PATH);
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);

        // Verify credentials were saved with encryption
        const credentialsRaw = readFileSync(CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(credentialsRaw);

        // Verify v2 encrypted format
        expect(credentials.version).toBe(2);
        expect(credentials.claudeAiOauth).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.encrypted).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.iv).toBeDefined();
        expect(credentials.claudeAiOauth.accessToken.tag).toBeDefined();

        // Verify PKCE state was cleaned up after successful exchange
        expect(existsSync(PKCE_STATE_PATH)).toBe(false);
      } finally {
        // Cleanup - restore real fetch
        vi.unstubAllGlobals();
      }
    });

    it('should validate state matches PKCE state (security test)', async () => {
      // Import service
      const { startClaudeLogin, sendLoginCode } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Start OAuth login first to initialize PKCE state
      const loginResult = await startClaudeLogin();
      expect(loginResult.started).toBe(true);
      expect(loginResult.url).toBeDefined();

      // Verify PKCE state was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);
      const pkceState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
      expect(pkceState.codeVerifier).toBeDefined();
      expect(pkceState.state).toBeDefined();

      // Act - Try to send code with MISMATCHED state (CSRF attack simulation)
      const authCode = 'mock_auth_code_12345';
      const maliciousState = 'attacker_controlled_state_value_xyz';
      const maliciousInput = `${authCode}#${maliciousState}`;

      const result = await sendLoginCode(maliciousInput);

      // Assert - Should REJECT due to state mismatch (CSRF protection)
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.toLowerCase()).toContain('state');
      expect(result.error?.toLowerCase()).toMatch(/mismatch|invalid|match/);

      // Verify credentials were NOT saved (attack blocked)
      expect(existsSync(CREDENTIALS_PATH)).toBe(false);

      // Verify PKCE state was NOT cleaned up (login still pending, not completed)
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);
    });
  });

  describe('getLoginState', () => {
    it('should return idle state when no login active', async () => {
      // Import service
      const { getLoginState, cancelLogin } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Ensure no login is active by canceling any existing login
      cancelLogin();

      // Verify PKCE state file doesn't exist (clean state)
      expect(existsSync(PKCE_STATE_PATH)).toBe(false);

      // Act - Get login state when no login is active
      const state = getLoginState();

      // Assert - Should return idle state
      expect(state).toBeDefined();
      expect(typeof state).toBe('object');

      // Verify state structure matches LoginState interface
      // According to auth-anthropic.ts, LoginState has:
      // - active: boolean
      // - url: string | null
      // - error: string | null
      // - waitingForCode: boolean
      // - startedAt: number
      // When idle, active should be false and url/error should be null
      expect(state.active).toBe(false);
      expect(state.url).toBeNull();
      expect(state.error).toBeNull();
      expect(state.waitingForCode).toBe(false);
      expect(state.startedAt).toBe(0);

      // This test verifies the idle state behavior:
      // 1. No active login (PKCE state file doesn't exist)
      // 2. getLoginState() returns active=false
      // 3. No URL or error in the response
      // This is the default state when the user hasn't started OAuth flow yet
    });

    it('should return waiting state when login in progress', async () => {
      // Import service
      const { startClaudeLogin, getLoginState } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Start a login to create an active PKCE flow
      const loginResult = await startClaudeLogin();

      // Verify login started successfully
      expect(loginResult.started).toBe(true);
      expect(loginResult.url).toBeDefined();

      // Verify PKCE state file was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);

      // Act - Get login state while login is in progress
      const state = getLoginState();

      // Assert - Should return waiting state
      expect(state).toBeDefined();
      expect(typeof state).toBe('object');

      // Verify state indicates active login
      expect(state.active).toBe(true);
      expect(state.waitingForCode).toBe(true);

      // Verify OAuth URL is included
      expect(state.url).toBeDefined();
      expect(typeof state.url).toBe('string');
      expect(state.url).toBe(loginResult.url); // Should match the URL from startClaudeLogin

      // Verify no error when login is in progress
      expect(state.error).toBeNull();

      // Verify startedAt timestamp is recent (within last 5 seconds)
      expect(state.startedAt).toBeGreaterThan(0);
      const now = Date.now();
      expect(now - state.startedAt).toBeLessThan(5000);

      // This test verifies the waiting state behavior:
      // 1. Login is active (PKCE state file exists)
      // 2. getLoginState() returns active=true, waitingForCode=true
      // 3. OAuth URL is included in the response
      // 4. startedAt timestamp is populated
      // This state allows the UI to show "Waiting for code" with the OAuth URL
    });

    it('should clean up stale logins (>5min old)', async () => {
      // Import service and file system functions
      const { startClaudeLogin, getLoginState } = await import('../../src/services/auth-anthropic.js');
      const { writeFileSync } = await import('fs');

      // Setup fake timers to control time
      vi.useFakeTimers();

      try {
        // Arrange - Start a login at time T
        const loginResult = await startClaudeLogin();
        expect(loginResult.started).toBe(true);
        expect(loginResult.url).toBeDefined();

        // Verify PKCE state file was created
        expect(existsSync(PKCE_STATE_PATH)).toBe(true);

        // Read the PKCE state to get the startedAt timestamp
        const initialState = JSON.parse(readFileSync(PKCE_STATE_PATH, 'utf-8'));
        expect(initialState.startedAt).toBeDefined();

        // Manually modify the startedAt timestamp to simulate a stale login
        // Set it to 6 minutes ago (>5min timeout)
        const sixMinutesAgo = Date.now() - (6 * 60 * 1000);
        initialState.startedAt = sixMinutesAgo;

        // Write the modified state back to disk
        writeFileSync(PKCE_STATE_PATH, JSON.stringify(initialState, null, 2), { mode: 0o600 });

        // Advance time by 6 minutes to match the fake startedAt
        vi.advanceTimersByTime(6 * 60 * 1000);

        // Act - Call getLoginState() which should detect and clean up the stale login
        const state = getLoginState();

        // Assert - Should return idle state (stale login cleaned up)
        expect(state).toBeDefined();
        expect(typeof state).toBe('object');

        // Verify state shows no active login (stale login was cleaned up)
        expect(state.active).toBe(false);
        expect(state.waitingForCode).toBe(false);
        expect(state.url).toBeNull();
        expect(state.error).toBeNull();
        expect(state.startedAt).toBe(0);

        // Verify PKCE state file was removed during cleanup
        expect(existsSync(PKCE_STATE_PATH)).toBe(false);

        // This test verifies automatic stale login cleanup:
        // 1. Login older than 5 minutes is considered stale
        // 2. getLoginState() detects stale login and cleans it up
        // 3. Returns idle state after cleanup
        // 4. PKCE state file is removed
        // This prevents:
        // - Abandoned logins blocking new attempts
        // - Security risk from long-lived PKCE states
        // - UI showing stale "Waiting for code" indefinitely
      } finally {
        // Cleanup - restore real timers
        vi.useRealTimers();
      }
    });
  });

  describe('cancelLogin', () => {
    it('should clear login state when login is active', async () => {
      // Import service
      const { startClaudeLogin, getLoginState, cancelLogin } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Start a login to create an active PKCE flow
      const loginResult = await startClaudeLogin();

      // Verify login started successfully
      expect(loginResult.started).toBe(true);
      expect(loginResult.url).toBeDefined();

      // Verify PKCE state file was created
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);

      // Verify login state is active (before cancellation)
      const stateBefore = getLoginState();
      expect(stateBefore.active).toBe(true);
      expect(stateBefore.waitingForCode).toBe(true);
      expect(stateBefore.url).toBeDefined();

      // Act - Cancel the login
      cancelLogin();

      // Assert - Login state should be cleared
      const stateAfter = getLoginState();
      expect(stateAfter.active).toBe(false);
      expect(stateAfter.waitingForCode).toBe(false);
      expect(stateAfter.url).toBeNull();
      expect(stateAfter.error).toBeNull();
      expect(stateAfter.startedAt).toBe(0);

      // Assert - PKCE state file should be removed
      expect(existsSync(PKCE_STATE_PATH)).toBe(false);

      // Assert - Should allow new login to start after cancellation
      const newLoginResult = await startClaudeLogin();
      expect(newLoginResult.started).toBe(true);
      expect(newLoginResult.url).toBeDefined();

      // Verify new login has different OAuth URL (new PKCE values)
      expect(newLoginResult.url).not.toBe(loginResult.url);

      // Verify PKCE state file was recreated
      expect(existsSync(PKCE_STATE_PATH)).toBe(true);

      // This test verifies the cancelLogin behavior:
      // 1. Clears in-memory login state (active=false, waitingForCode=false)
      // 2. Removes PKCE state file (.pkce-state.json)
      // 3. Allows new login to start immediately (not blocked)
      // 4. New login generates fresh PKCE values (different URL)
      // This is critical for:
      // - User canceling OAuth flow
      // - Cleanup after failed login
      // - Resetting state before retry
    });

    it('should be idempotent (safe to call when no login active)', async () => {
      // Import service
      const { cancelLogin, getLoginState } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Ensure no login is active
      cancelLogin(); // First call to ensure clean state

      // Verify PKCE state file doesn't exist
      expect(existsSync(PKCE_STATE_PATH)).toBe(false);

      // Verify login state is idle
      const stateBefore = getLoginState();
      expect(stateBefore.active).toBe(false);

      // Act - Call cancelLogin again when no login is active
      cancelLogin(); // Should be safe (idempotent operation)

      // Assert - State should remain idle (no errors thrown)
      const stateAfter = getLoginState();
      expect(stateAfter.active).toBe(false);
      expect(stateAfter.waitingForCode).toBe(false);
      expect(stateAfter.url).toBeNull();
      expect(stateAfter.error).toBeNull();
      expect(stateAfter.startedAt).toBe(0);

      // Assert - PKCE state file should still not exist
      expect(existsSync(PKCE_STATE_PATH)).toBe(false);

      // This test verifies idempotency:
      // - cancelLogin() is safe to call multiple times
      // - No errors thrown when canceling idle state
      // - State remains consistent (idle)
      // This is important for:
      // - User clicking "Cancel" button multiple times
      // - Cleanup in error handlers (safe to always call)
      // - Test teardown (beforeEach/afterEach cleanup)
    });
  });

  describe('isClaudeAuthenticated', () => {
    it('should prioritize CLAUDE_CODE_OAUTH_TOKEN env var (priority 1)', async () => {
      // Import service and invalidateAuthCache to clear any cached state
      const { isClaudeAuthenticated, invalidateAuthCache } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Set environment variable with valid token format
      const mockEnvToken = 'sk-ant-oat01-mock-env-token-1234567890';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = mockEnvToken;

      // Ensure no credentials file exists (to prove env var takes priority)
      if (existsSync(CREDENTIALS_PATH)) {
        rmSync(CREDENTIALS_PATH, { force: true });
      }

      try {
        // Clear auth cache to force fresh check
        invalidateAuthCache();

        // Act - Check authentication status
        const isAuthenticated = isClaudeAuthenticated();

        // Assert - Should return true (env var found)
        expect(isAuthenticated).toBe(true);

        // Verify: Even without credentials file, env var is sufficient
        expect(existsSync(CREDENTIALS_PATH)).toBe(false);

        // This test verifies the authentication priority chain:
        // 1. CLAUDE_CODE_OAUTH_TOKEN env var is checked FIRST (highest priority)
        // 2. Bypasses .credentials.json file check entirely
        // 3. Returns true if env var contains valid token format (sk-ant-oat01-*)
        // This is critical for:
        // - CI/CD pipelines using env vars for auth
        // - Docker deployments with secrets management
        // - Override mechanism for testing/debugging
      } finally {
        // Cleanup - remove env var
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        invalidateAuthCache();
      }
    });

    it('should fall back to .credentials.json when env var not set (priority 2)', async () => {
      // Import services
      const { sendLoginCode, isClaudeAuthenticated, invalidateAuthCache, _resetInMemoryTokenForTesting } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Ensure env var is NOT set
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      // Create credentials file with a direct token
      const mockToken = 'sk-ant-oat01-mock-credentials-file-token-12345';
      const result = await sendLoginCode(mockToken);
      expect(result.success).toBe(true);

      // Verify credentials file was created
      expect(existsSync(CREDENTIALS_PATH)).toBe(true);

      try {
        // Clear auth cache to force fresh check
        invalidateAuthCache();

        // Act - Check authentication status
        const isAuthenticated = isClaudeAuthenticated();

        // Assert - Should return true (credentials file found)
        expect(isAuthenticated).toBe(true);

        // Verify the priority order:
        // 1. Env var is NOT set (would have priority if it were)
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        // 2. Credentials file exists and contains valid token
        expect(existsSync(CREDENTIALS_PATH)).toBe(true);

        // This test verifies the authentication priority chain:
        // - When CLAUDE_CODE_OAUTH_TOKEN env var is NOT set
        // - Falls back to .credentials.json file (priority 2)
        // - Returns true if file contains valid encrypted token
        // This is the standard authentication flow for:
        // - OAuth login via web UI
        // - Persistent authentication between restarts
        // - Production deployments without env var overrides
      } finally {
        // Cleanup - ensure env var stays deleted
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        invalidateAuthCache();
      }
    });

    it('should fall back to legacy plaintext .credentials.json (priority 3)', async () => {
      // Import services
      const { isClaudeAuthenticated, invalidateAuthCache } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Ensure env var is NOT set
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      // Create legacy plaintext credentials file (no "version": 2)
      const legacyCredentials = {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-legacy-plaintext-token-1234567890abcdef1234567890',
          refreshToken: '',
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year from now
        },
        accountInfo: null,
      };

      // Write legacy format (plaintext, no encryption)
      mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
      writeFileSync(CREDENTIALS_PATH, JSON.stringify(legacyCredentials, null, 2), { mode: 0o600 });

      // Verify credentials file was created
      expect(existsSync(CREDENTIALS_PATH)).toBe(true);

      try {
        // Clear auth cache to force fresh check
        invalidateAuthCache();

        // Act - Check authentication status
        const isAuthenticated = isClaudeAuthenticated();

        // Assert - Should return true (legacy credentials file found)
        expect(isAuthenticated).toBe(true);

        // Verify the priority order:
        // 1. Env var is NOT set (would have priority if it were)
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        // 2. Credentials file exists in legacy plaintext format (no "version": 2)
        expect(existsSync(CREDENTIALS_PATH)).toBe(true);

        // Verify legacy format (no version field)
        const credentialsRaw = readFileSync(CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(credentialsRaw);
        expect(credentials.version).toBeUndefined(); // Legacy format has no version field
        expect(credentials.claudeAiOauth.accessToken).toBe('sk-ant-oat01-legacy-plaintext-token-1234567890abcdef1234567890');

        // This test verifies the authentication priority chain:
        // - When CLAUDE_CODE_OAUTH_TOKEN env var is NOT set
        // - Falls back to .credentials.json file (priority 2/3)
        // - Handles legacy plaintext format (no encryption, no version field)
        // This is important for backward compatibility:
        // - Existing installations with old credentials file
        // - Migration from Claude CLI v1 to v2
        // - Preserves authentication without re-login
      } finally {
        // Cleanup - ensure env var stays deleted
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        invalidateAuthCache();
      }
    });

    it('should cache authentication status for 3 seconds (AUTH_CACHE_TTL)', async () => {
      // Import services and vitest fake timers
      const { sendLoginCode, isClaudeAuthenticated, invalidateAuthCache, _resetInMemoryTokenForTesting } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Create encrypted credentials file
      const mockToken = 'sk-ant-oat01-test-cache-ttl-token-1234567890';

      // Use sendLoginCode to create encrypted credentials file
      await sendLoginCode(mockToken);

      // Verify credentials file exists
      expect(existsSync(CREDENTIALS_PATH)).toBe(true);

      // Ensure env var is NOT set (test priority 2: credentials file)
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        // Use fake timers for time control
        vi.useFakeTimers();

        // Clear auth cache to force fresh check
        invalidateAuthCache();

        // Act 1 - First call: cache miss, reads from credentials file
        const firstCheck = isClaudeAuthenticated();
        expect(firstCheck).toBe(true);

        // Delete ALL token sources to prove cache is being used
        rmSync(CREDENTIALS_PATH, { force: true });
        if (existsSync(TOKEN_CACHE_PATH)) rmSync(TOKEN_CACHE_PATH, { force: true });
        if (existsSync(CREDENTIALS_BACKUP)) rmSync(CREDENTIALS_BACKUP, { force: true });
        _resetInMemoryTokenForTesting();
        expect(existsSync(CREDENTIALS_PATH)).toBe(false);

        // Act 2 - Second call (immediately after): cache hit, returns cached value
        // Even though credentials file was deleted, cache should return true
        const secondCheck = isClaudeAuthenticated();
        expect(secondCheck).toBe(true);

        // Act 3 - Advance time by 2.9 seconds (just under 3s TTL)
        vi.advanceTimersByTime(2900);

        // Cache should still be valid (< 3000ms)
        const thirdCheck = isClaudeAuthenticated();
        expect(thirdCheck).toBe(true);

        // Act 4 - Advance time by 0.1 seconds more (total 3s, cache expired)
        vi.advanceTimersByTime(100);

        // Cache TTL expired, should re-check credentials file (which doesn't exist now)
        const fourthCheck = isClaudeAuthenticated();
        expect(fourthCheck).toBe(false); // Credentials file was deleted, cache expired

        // This test verifies the 3-second cache TTL mechanism:
        // - Prevents excessive file system reads (performance optimization)
        // - Cache duration: 3000ms (AUTH_CACHE_TTL constant)
        // - Cache is invalidated after TTL expires
        // - isClaudeAuthenticated() returns cached value if called within 3s
        // - After 3s, re-checks credentials file
        // Critical for:
        // - Performance: Reduces I/O operations when frequently checking auth status
        // - WebSocket status broadcasts: Called on every status message
        // - API requests: Called on every protected endpoint access
      } finally {
        // Restore real timers
        vi.useRealTimers();

        // Cleanup - ensure env var stays deleted
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        invalidateAuthCache();
      }
    });

    it('should invalidate cache immediately when invalidateAuthCache() is called', async () => {
      // Import services
      const { sendLoginCode, isClaudeAuthenticated, invalidateAuthCache, _resetInMemoryTokenForTesting } = await import('../../src/services/auth-anthropic.js');

      // Arrange - Create encrypted credentials file
      const mockToken = 'sk-ant-oat01-test-cache-invalidation-token-xyz';

      // Use sendLoginCode to create encrypted credentials file
      await sendLoginCode(mockToken);

      // Verify credentials file exists
      expect(existsSync(CREDENTIALS_PATH)).toBe(true);

      // Ensure env var is NOT set (test priority 2: credentials file)
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        // Use fake timers for time control
        vi.useFakeTimers();

        // Clear auth cache to force fresh check
        invalidateAuthCache();

        // Act 1 - First call: cache miss, reads from credentials file
        const firstCheck = isClaudeAuthenticated();
        expect(firstCheck).toBe(true);

        // Delete ALL token sources
        rmSync(CREDENTIALS_PATH, { force: true });
        if (existsSync(TOKEN_CACHE_PATH)) rmSync(TOKEN_CACHE_PATH, { force: true });
        if (existsSync(CREDENTIALS_BACKUP)) rmSync(CREDENTIALS_BACKUP, { force: true });
        _resetInMemoryTokenForTesting();
        expect(existsSync(CREDENTIALS_PATH)).toBe(false);

        // Act 2 - Second call (immediately after): cache hit, returns cached value
        // Even though credentials file was deleted, cache should return true
        const secondCheck = isClaudeAuthenticated();
        expect(secondCheck).toBe(true);

        // Act 3 - Call invalidateAuthCache() to force cache invalidation
        // WITHOUT advancing time (still within 3s TTL)
        invalidateAuthCache();

        // Act 4 - Third call: cache was invalidated, should re-check credentials file
        // File doesn't exist anymore, so should return false
        const thirdCheck = isClaudeAuthenticated();
        expect(thirdCheck).toBe(false);

        // Restore credentials file and verify cache is still invalidated
        await sendLoginCode(mockToken);
        expect(existsSync(CREDENTIALS_PATH)).toBe(true);

        // Call again without invalidating - should start caching again
        const fourthCheck = isClaudeAuthenticated();
        expect(fourthCheck).toBe(true);

        // Delete ALL token sources again
        rmSync(CREDENTIALS_PATH, { force: true });
        if (existsSync(TOKEN_CACHE_PATH)) rmSync(TOKEN_CACHE_PATH, { force: true });
        if (existsSync(CREDENTIALS_BACKUP)) rmSync(CREDENTIALS_BACKUP, { force: true });
        _resetInMemoryTokenForTesting();
        expect(existsSync(CREDENTIALS_PATH)).toBe(false);

        // Cache should return true (cached from fourthCheck)
        const fifthCheck = isClaudeAuthenticated();
        expect(fifthCheck).toBe(true);

        // This test verifies the manual cache invalidation mechanism:
        // - invalidateAuthCache() forces an immediate cache invalidation
        // - Next isClaudeAuthenticated() call will re-check credentials file
        // - Works even if TTL has not expired yet (within 3s)
        // - Critical for:
        //   - OAuth login completion (new token saved, need immediate re-check)
        //   - Token refresh (updated token, bypass cache)
        //   - Manual logout (token removed, force re-check)
        //   - API 401 errors (markTokenExpired calls invalidateAuthCache)
      } finally {
        // Restore real timers
        vi.useRealTimers();

        // Cleanup - ensure env var stays deleted
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        invalidateAuthCache();
      }
    });
  });
});
