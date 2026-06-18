/**
 * services/console.ts tests
 *
 * Tests session management: create, destroy, attach, buffer output
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock node-pty before importing console service (use vi.hoisted for mock functions)
const {
	mockPtySpawn,
	mockPtyOnData,
	mockPtyWrite,
	mockPtyResize,
	mockPtyKill,
} = vi.hoisted(() => ({
	mockPtySpawn: vi.fn(),
	mockPtyOnData: vi.fn(),
	mockPtyWrite: vi.fn(),
	mockPtyResize: vi.fn(),
	mockPtyKill: vi.fn(),
}));

vi.mock("node-pty", () => ({
	spawn: mockPtySpawn,
}));

// Mock dependencies
vi.mock("../../apps/runtime/src/services/claude-env.js", () => ({
	getValidAgentBinary: vi.fn(() => "/usr/local/bin/claude"),
	resolveAgentBinary: vi.fn(() => "/usr/local/bin/claude"),
	getOAuthEnv: vi.fn(() => ({ CLAUDE_CODE_OAUTH_TOKEN: "mock-token-12345" })),
	ensureOnboardingComplete: vi.fn(),
	buildCleanEnv: vi.fn(() => ({ PATH: "/usr/bin", HOME: "/root" })),
	getAgentBinaryPath: vi.fn(() => "/usr/local/bin/claude"),
	setAgentBinaryPath: vi.fn(),
}));

vi.mock("../../apps/runtime/src/services/permissions.js", () => ({
	syncToClaudeSettings: vi.fn(),
}));

vi.mock("../../apps/runtime/src/services/accounts.js", () => {
	const account = {
		uuid: "default",
		email: null,
		organizationName: null,
		organizationUuid: null,
		label: "Default account",
		configDir: "/root/.claude",
		isDefault: true,
		addedAt: 0,
	};
	return {
		resolveAccountForSession: vi.fn(() => account),
		getAccountSessionEnv: vi.fn(() => ({
			CLAUDE_CODE_OAUTH_TOKEN: "mock-token-12345",
		})),
		prepareAccountConfigDir: vi.fn(),
		getAccountPaths: vi.fn(() => ({
			configDir: "/root/.claude",
			credentialsFile: "/root/.claude/.credentials.json",
			configFile: "/root/.claude.json",
			settingsFile: "/root/.claude/settings.json",
			projectsDir: "/root/.claude/projects",
			setConfigDirEnv: false,
		})),
	};
});

vi.mock("../../apps/runtime/src/services/session-writer.js", () => ({
	startSessionCapture: vi.fn(),
	captureInput: vi.fn(),
	captureOutput: vi.fn(),
	endSessionCapture: vi.fn(),
}));

vi.mock("../../apps/runtime/src/services/session-summarizer.js", () => ({
	summarizeSession: vi.fn(),
}));

vi.mock("../../apps/runtime/src/services/memory-context.js", () => ({
	injectContextIntoCLAUDEMd: vi.fn(),
}));

vi.mock("../../apps/runtime/src/services/memory.js", () => ({
	atomicWriteFileSync: vi.fn(),
}));

vi.mock("../../apps/runtime/src/services/agent.js", () => ({
	ACTIVE_AGENT: {
		command: "claude",
		flags: {
			continue: "--continue",
			resume: "--resume",
		},
	},
}));

// Import console service after mocks
import {
	createConsoleSession,
	getSession,
	getSessionCount,
	destroySession,
	destroyAllSessions,
} from "../../apps/runtime/src/services/console.js";

const TEST_ROOT = join(tmpdir(), "codeck-test-" + process.pid);
const CODECK_DIR = process.env.CODECK_DIR || join(TEST_ROOT, ".codeck");
const STATE_DIR = join(CODECK_DIR, "state");
const SESSIONS_STATE_FILE = join(STATE_DIR, "sessions.json");
const TEST_WORKSPACE = join(TEST_ROOT, "test-project");

describe("services/console.ts - Session Management", () => {
	beforeEach(() => {
		// Create test workspace directory
		if (!existsSync(TEST_WORKSPACE)) {
			mkdirSync(TEST_WORKSPACE, { recursive: true });
		}

		// Create state directory
		if (!existsSync(STATE_DIR)) {
			mkdirSync(STATE_DIR, { recursive: true });
		}

		// Setup mock PTY spawn to return a mock PTY object
		mockPtySpawn.mockReturnValue({
			onData: mockPtyOnData,
			onExit: vi.fn(),
			write: mockPtyWrite,
			resize: mockPtyResize,
			kill: mockPtyKill,
			pid: 12345,
		});

		// Reset mocks
		vi.clearAllMocks();
	});

	afterEach(() => {
		// Destroy all sessions to prevent exceeding MAX_SESSIONS across tests
		destroyAllSessions();

		// Clean up entire test root (workspace + codeck state)
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true, force: true });
		}
	});

	describe("createConsoleSession", () => {
		it("should spawn PTY with claude CLI", () => {
			// Act: Create a console session
			const session = createConsoleSession({ cwd: TEST_WORKSPACE });

			// Assert: Session created successfully
			expect(session).toBeDefined();
			expect(session.id).toMatch(/^[a-f0-9-]{36}$/); // UUID format
			expect(session.type).toBe("agent");
			expect(session.cwd).toBe(TEST_WORKSPACE);
			expect(session.name).toBe("test-project");
			expect(session.createdAt).toBeGreaterThan(0);
			expect(session.attached).toBe(false);
			expect(session.outputBuffer).toEqual([]);
			expect(session.outputBufferSize).toBe(0);

			// Assert: PTY spawned with correct arguments
			expect(mockPtySpawn).toHaveBeenCalledTimes(1);
			expect(mockPtySpawn).toHaveBeenCalledWith(
				"/usr/local/bin/claude",
				[], // No resume/continue flags
				expect.objectContaining({
					name: "xterm-256color",
					cols: 120,
					rows: 30,
					cwd: TEST_WORKSPACE,
					env: expect.objectContaining({
						CLAUDE_CODE_OAUTH_TOKEN: "mock-token-12345",
						TERM: "xterm-256color",
						PATH: "/usr/bin",
						HOME: "/root",
					}),
				}),
			);

			// Assert: Session registered
			expect(getSessionCount()).toBe(1);
			expect(getSession(session.id)).toBe(session);
		});

		it("should prepare the account config dir (onboarding + settings) before spawning PTY", async () => {
			// Onboarding + permission sync now happen inside prepareAccountConfigDir,
			// which is account-aware (writes into the session's CLAUDE_CONFIG_DIR).
			const { prepareAccountConfigDir, resolveAccountForSession } = await import(
				"../../apps/runtime/src/services/accounts.js"
			);

			// Act: Create a console session
			createConsoleSession({ cwd: TEST_WORKSPACE });

			// Assert: the account was resolved and its config dir prepared before spawn
			expect(resolveAccountForSession).toHaveBeenCalledTimes(1);
			expect(prepareAccountConfigDir).toHaveBeenCalledTimes(1);
		});

		it("should strip sensitive env vars (NODE_ENV, PORT, ANTHROPIC_API_KEY)", async () => {
			// Arrange: Import buildCleanEnv mock to verify it's called
			const { buildCleanEnv } = await import(
				"../../apps/runtime/src/services/claude-env.js"
			);

			// Reset the mock to track calls
			vi.mocked(buildCleanEnv).mockClear();

			// Act: Create a console session (which calls buildCleanEnv internally)
			const session = createConsoleSession({ cwd: TEST_WORKSPACE });

			// Assert: buildCleanEnv was called to strip sensitive env vars
			expect(buildCleanEnv).toHaveBeenCalledTimes(1);

			// Assert: PTY spawned with clean env (no NODE_ENV, PORT, ANTHROPIC_API_KEY)
			// The mock returns { PATH: '/usr/bin', HOME: '/root' } which simulates stripped env
			expect(mockPtySpawn).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Array),
				expect.objectContaining({
					env: expect.objectContaining({
						CLAUDE_CODE_OAUTH_TOKEN: "mock-token-12345", // OAuth token
						PATH: "/usr/bin", // Clean env preserved
						HOME: "/root", // Clean env preserved
						TERM: "xterm-256color", // TERM added
					}),
				}),
			);

			// Assert: PTY env should NOT contain NODE_ENV or PORT
			// (These are stripped by buildCleanEnv before merging with OAuth env)
			const spawnCall =
				mockPtySpawn.mock.calls[mockPtySpawn.mock.calls.length - 1];
			const spawnedEnv = spawnCall[2].env;
			expect(spawnedEnv.NODE_ENV).toBeUndefined();
			expect(spawnedEnv.PORT).toBeUndefined();
			expect(spawnedEnv.ANTHROPIC_API_KEY).toBeUndefined();
		});

		it("should set TERM=xterm-256color in environment", () => {
			// Act: Create a console session
			const session = createConsoleSession({ cwd: TEST_WORKSPACE });

			// Assert: PTY spawned with TERM env var set to xterm-256color (line 60)
			expect(mockPtySpawn).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Array),
				expect.objectContaining({
					env: expect.objectContaining({
						TERM: "xterm-256color",
					}),
				}),
			);

			// Assert: PTY also configured with name='xterm-256color' (line 87)
			expect(mockPtySpawn).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Array),
				expect.objectContaining({
					name: "xterm-256color",
				}),
			);
		});

		it("should generate unique UUID for each session", () => {
			// Act: Create multiple sessions
			const session1 = createConsoleSession({ cwd: TEST_WORKSPACE });
			const session2 = createConsoleSession({ cwd: TEST_WORKSPACE });
			const session3 = createConsoleSession({ cwd: TEST_WORKSPACE });

			// Assert: Each session has a valid UUID v4 format (randomUUID from crypto module)
			expect(session1.id).toMatch(
				/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
			);
			expect(session2.id).toMatch(
				/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
			);
			expect(session3.id).toMatch(
				/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
			);

			// Assert: Each session has a UNIQUE ID
			expect(session1.id).not.toBe(session2.id);
			expect(session1.id).not.toBe(session3.id);
			expect(session2.id).not.toBe(session3.id);

			// Assert: All IDs are different (no collisions)
			const ids = new Set([session1.id, session2.id, session3.id]);
			expect(ids.size).toBe(3); // Set deduplicates, so size should be 3
		});

		it("should return complete session info object", () => {
			// Act: Create a console session
			const session = createConsoleSession({ cwd: TEST_WORKSPACE });

			// Assert: Session object has all required properties (console.ts:19-29 ConsoleSession interface)
			expect(session).toHaveProperty("id");
			expect(session).toHaveProperty("type");
			expect(session).toHaveProperty("pty");
			expect(session).toHaveProperty("cwd");
			expect(session).toHaveProperty("name");
			expect(session).toHaveProperty("createdAt");
			expect(session).toHaveProperty("outputBuffer");
			expect(session).toHaveProperty("outputBufferSize");
			expect(session).toHaveProperty("attached");

			// Assert: Property types are correct
			expect(typeof session.id).toBe("string");
			expect(session.type).toBe("agent"); // Always 'agent' for createConsoleSession
			expect(session.pty).toBeDefined();
			expect(typeof session.cwd).toBe("string");
			expect(typeof session.name).toBe("string");
			expect(typeof session.createdAt).toBe("number");
			expect(Array.isArray(session.outputBuffer)).toBe(true);
			expect(typeof session.outputBufferSize).toBe("number");
			expect(typeof session.attached).toBe("boolean");

			// Assert: Session is retrievable via getSession(id)
			const retrieved = getSession(session.id);
			expect(retrieved).toBe(session); // Same reference
			expect(retrieved?.id).toBe(session.id);
		});
	});
});
