/**
 * Vitest global setup — runs BEFORE any test file imports.
 *
 * Redirects all auth/config paths to /tmp/codeck-test/ so tests
 * never touch the live server's files in /workspace/.codeck/ or /root/.claude/.
 */
import { mkdirSync, rmSync } from 'fs';

const TEST_ROOT = '/tmp/codeck-test';
const TEST_CODECK_DIR = `${TEST_ROOT}/.codeck`;
const TEST_CLAUDE_DIR = `${TEST_ROOT}/.claude`;

// Clean slate
rmSync(TEST_ROOT, { recursive: true, force: true });
mkdirSync(TEST_CODECK_DIR, { recursive: true, mode: 0o700 });
mkdirSync(TEST_CLAUDE_DIR, { recursive: true, mode: 0o700 });

const TEST_WORKSPACE = `${TEST_ROOT}/workspace`;

// Set env vars BEFORE any module imports read them
process.env.CODECK_DIR = TEST_CODECK_DIR;
process.env.CLAUDE_CONFIG_DIR = TEST_CLAUDE_DIR;
process.env.WORKSPACE = TEST_WORKSPACE;

// Disable daemon delegation so system routes run in isolated mode
delete process.env.CODECK_DAEMON_URL;

// Create test workspace directory
mkdirSync(TEST_WORKSPACE, { recursive: true });
