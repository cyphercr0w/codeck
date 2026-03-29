import { spawn as ptySpawn, type IPty } from "node-pty";
import {
	readFileSync,
	existsSync,
	mkdirSync,
	unlinkSync,
	renameSync,
	realpathSync,
	readdirSync,
	lstatSync,
	symlinkSync,
} from "fs";
import { readdir as readdirAsync, stat as statAsync } from "fs/promises";
import { randomUUID } from "crypto";
import { resolve, join } from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);
import { ACTIVE_AGENT } from "./agent.js";
import { syncToClaudeSettings } from "./permissions.js";
import {
	startSessionCapture,
	captureInput,
	captureOutput,
	endSessionCapture,
} from "./session-writer.js";
import { atomicWriteFileSync } from "./memory.js";
import { decryptValue } from "./auth-anthropic/encryption.js";
import { broadcast } from "../web/logger.js";
import {
	injectContextIntoCLAUDEMd,
	type ContextInjectionStats,
} from "./memory-context.js";
import { startTeammateWatcher } from "./teammate-watcher.js";
import {
	getValidAgentBinary,
	resolveAgentBinary,
	getOAuthEnv,
	ensureOnboardingComplete,
	buildCleanEnv,
	getAgentBinaryPath,
	setAgentBinaryPath,
} from "./claude-env.js";

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max buffered output per session
export const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "5", 10);

interface ConsoleSession {
	id: string;
	type: "agent" | "shell";
	pty: IPty;
	cwd: string;
	name: string;
	createdAt: number;
	outputBuffer: string[];
	outputBufferSize: number;
	attached: boolean;
	conversationId?: string;
	dataDisposable?: { dispose: () => void };
}

const sessions = new Map<string, ConsoleSession>();
// Set to true during destroyAllSessions() to suppress per-session state saves
// that would overwrite the shutdown snapshot with an empty session list.
let suppressStateSave = false;

// Callbacks invoked when any session's PTY exits — allows external modules
// (routes, websocket) to clean up per-session state without circular imports.
type SessionExitCallback = (sessionId: string, exitCode: number) => void;
const globalSessionExitCallbacks: SessionExitCallback[] = [];

export function onAnySessionExit(cb: SessionExitCallback): void {
	globalSessionExitCallbacks.push(cb);
}

console.log(`[Console] Agent binary resolved: ${getAgentBinaryPath()}`);

// Permissions are managed by services/permissions.ts
// Always syncs enabled permissions to ~/.claude/settings.json before spawn

interface CreateSessionOptions {
	cwd?: string;
	resume?: boolean;
	useContinue?: boolean; // use --continue (resumes most recent conv for cwd, no picker)
	continuationPrompt?: string;
	conversationId?: string;
	// Peer orchestration: additional args and env for agent PTY sessions
	extraArgs?: string[];
	extraEnv?: Record<string, string>;
	sessionType?: "agent" | "shell";
}

/**
 * Detect the conversation ID for a Claude session by polling the project dir.
 * - Fresh sessions: wait for a NEW .jsonl file to appear.
 * - Resume/continue sessions: wait for an EXISTING .jsonl file's mtime to change
 *   (Claude writes to it when the conversation is resumed).
 * Runs async (fire-and-forget) — does not block session creation.
 */
/**
 * Detect the conversation ID using fully async I/O.
 * Previous implementation used readdirSync/statSync/readFileSync inside a 500ms setInterval,
 * which blocked the Node.js event loop for seconds when project directories had many .jsonl files.
 * This caused the runtime to stop processing WS messages (including console:input) → input freeze.
 */
function detectConversationId(
	session: ConsoleSession,
	watchExisting = false,
): void {
	const encoded = encodeProjectPath(session.cwd);
	const projectDir = resolve(`${ACTIVE_AGENT.projectsDir}/${encoded}`);

	// Validate the resolved path stays within projectsDir to prevent path injection
	if (!ACTIVE_AGENT.projectsDir) return;
	const resolvedBase = resolve(ACTIVE_AGENT.projectsDir);
	if (
		!projectDir.startsWith(resolvedBase + "/") &&
		projectDir !== resolvedBase
	) {
		console.warn(
			`[Console] Path injection blocked: ${projectDir} is outside ${resolvedBase}`,
		);
		return;
	}

	(async () => {
		// Snapshot existing .jsonl files (and their mtimes for resume detection)
		const existingFiles = new Set<string>();
		const existingMtimes = new Map<string, number>();
		try {
			const entries = await readdirAsync(projectDir).catch(
				() => [] as string[],
			);
			for (const f of entries) {
				if (!f.endsWith(".jsonl")) continue;
				existingFiles.add(f);
				if (watchExisting) {
					try {
						const s = await statAsync(`${projectDir}/${f}`);
						existingMtimes.set(f, s.mtimeMs);
					} catch {
						/* ignore */
					}
				}
			}
		} catch {
			/* ignore */
		}

		// Poll (500ms intervals, up to 15s) — fully async to avoid blocking event loop
		let attempts = 0;
		const maxAttempts = 30;
		let polling = false;
		const interval = setInterval(async () => {
			if (polling) return; // Skip if previous async iteration still running
			// Stop polling if session was destroyed
			if (!sessions.has(session.id)) {
				clearInterval(interval);
				return;
			}
			polling = true;
			attempts++;
			try {
				const files = await readdirAsync(projectDir).catch(
					() => [] as string[],
				);
				const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

				let found: string | undefined;
				if (watchExisting) {
					// Resume mode: look for a file whose mtime has changed (Claude wrote to it)
					for (const f of jsonlFiles) {
						try {
							const s = await statAsync(`${projectDir}/${f}`);
							if (s.mtimeMs > (existingMtimes.get(f) ?? 0)) {
								found = f;
								break;
							}
						} catch {
							/* ignore */
						}
					}
				} else {
					// Fresh session: look for a brand-new file
					found = jsonlFiles.find((f) => !existingFiles.has(f));
				}

				if (found) {
					// Validate the file has real conversation messages (not just metadata like file-history-snapshot)
					if (!(await hasRealMessagesAsync(`${projectDir}/${found}`))) {
						// Not a real conversation yet — keep polling
						return;
					}
					session.conversationId = found.replace(".jsonl", "");
					saveSessionState("conversation_detected");
					console.log(
						`[Console] Detected conversation: ${session.conversationId} (${watchExisting ? "resume" : "new"})`,
					);
					// Notify frontend so "OPEN" badge appears on recent conversations
					broadcast({
						type: "session:conversationId",
						sessionId: session.id,
						conversationId: session.conversationId,
					});
					clearInterval(interval);
				} else if (attempts >= maxAttempts) {
					console.warn(
						`[Console] Could not detect conversation ID for session ${session.id}`,
					);
					clearInterval(interval);
				}
			} catch {
				clearInterval(interval);
			} finally {
				polling = false;
			}
		}, 500);
	})();
}

const RULES_DIR = "/root/.claude/rules";
const RULES_LIBRARY = "/workspace/.codeck/rules-library";

// Note: symlinks are global state under ~/.claude/rules/. In theory, concurrent
// session creation with different cwd values could race. In practice Codeck is
// single-user and sessions are created sequentially, so this is acceptable.
function setupLanguageRules(cwd: string): void {
	try {
		// Detect languages from indicator files
		const langs: string[] = [];

		// Only tsconfig.json triggers typescript — package.json alone is ambiguous (JS-only projects)
		if (existsSync(join(cwd, "tsconfig.json"))) {
			langs.push("typescript");
		}
		if (existsSync(join(cwd, "Cargo.toml"))) langs.push("rust");
		if (existsSync(join(cwd, "go.mod"))) langs.push("golang");
		if (
			existsSync(join(cwd, "pom.xml")) ||
			existsSync(join(cwd, "build.gradle"))
		) {
			langs.push("java");
		}
		if (existsSync(join(cwd, "build.gradle.kts"))) langs.push("kotlin");
		if (existsSync(join(cwd, "composer.json"))) langs.push("php");
		if (
			existsSync(join(cwd, "requirements.txt")) ||
			existsSync(join(cwd, "pyproject.toml"))
		) {
			langs.push("python");
		}
		if (existsSync(join(cwd, "Package.swift"))) langs.push("swift");
		if (existsSync(join(cwd, "CMakeLists.txt"))) langs.push("cpp");
		if (
			existsSync(join(cwd, "cpanfile")) ||
			existsSync(join(cwd, "Makefile.PL"))
		) {
			langs.push("perl");
		}
		try {
			if (
				readdirSync(cwd).some(
					(f) => f.endsWith(".csproj") || f.endsWith(".sln"),
				)
			) {
				langs.push("csharp");
			}
		} catch {
			/* non-fatal */
		}

		// Remove existing language symlinks (never touch common/ or typescript/)
		if (existsSync(RULES_DIR)) {
			try {
				for (const entry of readdirSync(RULES_DIR)) {
					if (entry === "common" || entry === "typescript") continue;
					const entryPath = join(RULES_DIR, entry);
					try {
						if (lstatSync(entryPath).isSymbolicLink()) {
							unlinkSync(entryPath);
						}
					} catch {
						/* skip unreadable entry */
					}
				}
			} catch {
				/* skip if rules dir unreadable */
			}
		} else {
			mkdirSync(RULES_DIR, { recursive: true });
		}

		// Create symlinks for detected languages (skip typescript — already a real dir)
		const toLink = langs.filter((l) => l !== "typescript");
		if (toLink.length === 0) {
			if (langs.length === 0) {
				console.log("[Rules] No additional language rules needed");
			}
			return;
		}

		for (const lang of toLink) {
			const src = join(RULES_LIBRARY, lang);
			const dest = join(RULES_DIR, lang);
			if (!existsSync(src)) continue;
			try {
				symlinkSync(src, dest);
			} catch (e) {
				console.warn(
					`[Rules] Failed to symlink ${lang}: ${(e as Error).message}`,
				);
			}
		}

		console.log(`[Rules] Detected: ${langs.join(", ")} → symlinked rules`);
	} catch (e) {
		console.warn(`[Rules] setupLanguageRules failed: ${(e as Error).message}`);
	}
}

// Simple mutex to prevent concurrent session creation from exceeding MAX_SESSIONS.
// Check-then-create is not atomic without this — two simultaneous POST /api/console/create
// could both pass the getSessionCount() < MAX_SESSIONS check before either creates a session.
// IMPORTANT: Synchronous-only mutex — works because createConsoleSession and
// _createConsoleSessionInner are fully synchronous. If an `await` is ever added inside
// _createConsoleSessionInner, replace with an async mutex (e.g., p-limit or promise chain).
let sessionCreationLocked = false;

export function createConsoleSession(
	options?: string | CreateSessionOptions,
): ConsoleSession {
	if (sessionCreationLocked) {
		throw new Error("Session creation in progress, please retry");
	}
	sessionCreationLocked = true;

	try {
		// Enforce MAX_SESSIONS inside the lock
		if (getSessionCount() >= MAX_SESSIONS) {
			throw new Error(`Maximum ${MAX_SESSIONS} simultaneous sessions`);
		}

		return _createConsoleSessionInner(options);
	} finally {
		sessionCreationLocked = false;
	}
}

function _createConsoleSessionInner(
	options?: string | CreateSessionOptions,
): ConsoleSession {
	const id = randomUUID();

	// Support legacy string-only cwd argument
	const opts: CreateSessionOptions =
		typeof options === "string" ? { cwd: options } : options || {};
	let workDir = resolve(opts.cwd || process.env.WORKSPACE || "/workspace");

	// Validate cwd exists — for resume, fall back to /workspace instead of failing
	if (!existsSync(workDir)) {
		if (opts.resume) {
			const fallback = process.env.WORKSPACE || "/workspace";
			console.warn(
				`[Console] Resume cwd missing (${workDir}), falling back to ${fallback}`,
			);
			workDir = fallback;
		} else {
			throw new Error(`Working directory does not exist: ${workDir}`);
		}
	}

	ensureOnboardingComplete();
	syncToClaudeSettings();

	const oauthEnv = getOAuthEnv();

	// Load user env vars (API keys, tokens saved by the agent)
	// Priority: encrypted .env.encrypted > plaintext .env (legacy)
	const userEnv: Record<string, string> = {};
	const wsDir = join(process.env.WORKSPACE || "/workspace", ".codeck");
	const encryptedEnvPath = join(wsDir, ".env.encrypted");
	const dotenvPath = join(wsDir, ".env");

	if (existsSync(encryptedEnvPath)) {
		try {
			const store = JSON.parse(readFileSync(encryptedEnvPath, "utf-8"));
			for (const v of store.vars || []) {
				if (v.key && v.value) userEnv[v.key] = decryptValue(v.value);
			}
		} catch {
			/* fall through to plaintext */
		}
	}

	if (Object.keys(userEnv).length === 0 && existsSync(dotenvPath)) {
		try {
			const content = readFileSync(dotenvPath, "utf-8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eqIdx = trimmed.indexOf("=");
				if (eqIdx > 0) {
					const key = trimmed.slice(0, eqIdx).trim();
					const val = trimmed
						.slice(eqIdx + 1)
						.trim()
						.replace(/^["']|["']$/g, "");
					if (key && val) userEnv[key] = val;
				}
			}
		} catch {
			/* non-fatal */
		}
	}

	const finalEnv: Record<string, string> = {
		...buildCleanEnv(),
		...userEnv,
		...oauthEnv,
		...(opts.extraEnv || {}),
		TERM: "xterm-256color",
		CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
		CODECK_SESSION_ID: id, // Must be LAST — prevents oauthEnv from overwriting
	};

	// Build CLI args from launch options
	const args: string[] = [];
	if (opts.useContinue) {
		// Restore/auto-resume: --continue picks the most recent conversation for this cwd
		args.push(ACTIVE_AGENT.flags.continue);
	} else if (opts.resume) {
		if (opts.conversationId) {
			// Auto-restore: resume specific conversation (no picker, no prompt needed)
			args.push(ACTIVE_AGENT.flags.resume, opts.conversationId);
		} else if (opts.continuationPrompt) {
			// Legacy: --continue with prompt (resumes most recent)
			args.push(ACTIVE_AGENT.flags.continue, "-p", opts.continuationPrompt);
		} else {
			// User-initiated: use --resume (shows interactive picker)
			args.push(ACTIVE_AGENT.flags.resume);
		}
	}

	// Append extra args for peer sessions (MCP config, channel flags, etc.)
	if (opts.extraArgs) {
		args.push(...opts.extraArgs);
	}

	// Inject memory context into workspace CLAUDE.md before spawning
	let contextStats: ContextInjectionStats | null = null;
	try {
		contextStats = injectContextIntoCLAUDEMd(workDir);
	} catch (e) {
		console.warn(
			`[Console] Memory context injection failed: ${(e as Error).message}`,
		);
	}

	// Inject Agent Teams instructions when enabled for this session
	if (finalEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1") {
		const teamsLines = [
			"## You are the LEADER of an Agent Team system.",
			"",
			"You do NOT implement code yourself. You are a coordinator. Your job is to:",
			"1. Understand what the user wants",
			"2. Break it into tasks",
			"3. Spawn specialized teammates (sub-agents) to execute each task",
			"4. Monitor their progress and report back to the user",
			"5. Review the results and iterate if needed",
			"",
			"### ALWAYS use teams for non-trivial work",
			"- Any task touching 2+ files → spawn teammates",
			"- Bug fix → implementer + reviewer",
			"- Feature → planner + implementer + reviewer",
			"- Research → exploration agent",
			"- If it can be parallelized, parallelize it.",
			"",
			"### How to coordinate",
			"1. TeamCreate — create a team (once per task group)",
			"2. TaskCreate — define tasks with clear descriptions",
			"3. Agent — spawn teammates with team_name, name, and model: 'sonnet'",
			"   Each teammate gets an ISOLATED context. They know NOTHING about your conversation.",
			"   You MUST give them everything they need in their prompt:",
			"   - Exact file paths to read/edit",
			"   - What was decided (don't make them re-research)",
			"   - What to do, what NOT to change, what to verify",
			"   - Think of it as a complete task brief for a new hire",
			"4. SendMessage — talk to teammates by name",
			"5. TaskList — check progress",
			"6. When done: SendMessage with {type: 'shutdown_request'} to each teammate",
			"",
			"### Rules",
			"- Teammates ALWAYS use model: 'sonnet' (never Opus — too slow/expensive)",
			"- ALWAYS spawn a reviewer after implementation work",
			"- After spawning teammates, tell the user what each one is doing",
			"- When teammates report back, summarize findings to the user",
			"- Never go silent — the user needs to know what's happening",
		];

		// Load pre-configured sub-agent definitions so the leader knows what's available
		const agentsDir = join(process.env.HOME || "/root", ".claude", "agents");
		try {
			const agentFiles = readdirSync(agentsDir).filter((f) =>
				f.endsWith(".md"),
			);
			if (agentFiles.length > 0) {
				const catalog: string[] = [];
				for (const file of agentFiles) {
					try {
						const content = readFileSync(join(agentsDir, file), "utf-8");
						const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
						if (!fmMatch) continue;
						const fm = fmMatch[1];
						const nameMatch = fm.match(/^name:\s*(.+)/m);
						const descMatch = fm.match(/^description:\s*(.+)/m);
						if (nameMatch) {
							const name = nameMatch[1].trim();
							const desc = descMatch ? descMatch[1].trim() : "";
							catalog.push(`- **${name}**: ${desc}`);
						}
					} catch {
						/* skip unreadable files */
					}
				}
				if (catalog.length > 0) {
					teamsLines.push(
						"",
						"### Pre-configured Sub-Agents",
						"Use `subagent_type` parameter to spawn these specialized agents. Prefer these over generic agents.",
						"",
						...catalog,
					);
				}
			}
		} catch {
			/* agents dir not found — skip catalog */
		}

		args.push("--append-system-prompt", teamsLines.join("\n"));
	}

	setupLanguageRules(workDir);

	const binary = getValidAgentBinary();
	console.log(
		`[Console] Spawning claude PTY: binary=${binary}, cwd=${workDir}, args=[${args.join(", ")}], sessions=${sessions.size}, OAUTH_TOKEN=${oauthEnv.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "NOT SET"}`,
	);

	let pty: IPty;
	try {
		pty = ptySpawn(binary, args, {
			name: "xterm-256color",
			cols: 120,
			rows: 30,
			cwd: workDir,
			env: finalEnv,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(
			`[Console] ptySpawn failed: ${msg} (binary=${binary}, cwd=${workDir})`,
		);
		throw new Error(`Failed to spawn ${ACTIVE_AGENT.command}: ${msg}`);
	}

	const name = workDir.split("/").pop() || workDir;
	const session: ConsoleSession = {
		id,
		type: opts.sessionType || "agent",
		pty,
		cwd: workDir,
		name,
		createdAt: Date.now(),
		outputBuffer: [],
		outputBufferSize: 0,
		attached: false,
	};

	// Start teammate pane watcher only for teams-enabled sessions
	if (finalEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1") {
		startTeammateWatcher(id, pty.pid);
	}

	// Set or detect conversation ID for agent sessions
	if (opts.conversationId) {
		// Known ID (auto-restore): set directly
		session.conversationId = opts.conversationId;
	} else if (opts.useContinue || (opts.resume && !opts.conversationId)) {
		// --continue or interactive --resume: detect which existing conversation was touched
		detectConversationId(session, true);
	} else if (!opts.resume) {
		// Fresh session: detect the new .jsonl file that Claude creates
		detectConversationId(session, false);
	}

	// Start session capture for transcript logging
	startSessionCapture(id, workDir);

	// Always capture PTY output for transcript logging (session JSONL).
	// Buffer output only when no WS client is attached (with size cap).
	const dataDisposable = pty.onData((data: string) => {
		captureOutput(id, data);
		if (!session.attached) {
			session.outputBuffer.push(data);
			session.outputBufferSize += data.length;
			while (
				session.outputBufferSize > MAX_BUFFER_SIZE &&
				session.outputBuffer.length > 0
			) {
				const dropped = session.outputBuffer.shift()!;
				session.outputBufferSize -= dropped.length;
			}
		}
	});
	session.dataDisposable = dataDisposable;

	// Register PTY exit handler at creation time — ensures cleanup even if no WS client
	// ever attaches. Without this, sessions created during restore that never get a WS
	// attachment become zombie entries in the sessions Map.
	pty.onExit(({ exitCode }: { exitCode: number }) => {
		for (const cb of globalSessionExitCallbacks) {
			try {
				cb(id, exitCode);
			} catch {
				/* non-fatal */
			}
		}
		if (sessions.has(id)) {
			destroySession(id);
		}
	});

	sessions.set(id, session);
	saveSessionState("session_created");

	// Broadcast context injection stats so the frontend can show a "Context Loaded" banner
	if (contextStats) {
		broadcast({
			type: "console:context_loaded",
			sessionId: id,
			data: contextStats,
		});
	}

	return session;
}

export function createShellSession(cwd?: string): ConsoleSession {
	const t0 = Date.now();
	const id = randomUUID();
	const workspace = resolve(process.env.WORKSPACE || "/workspace");
	const workDir = resolve(cwd || workspace);

	// Validate cwd stays within workspace to prevent path traversal
	if (!workDir.startsWith(workspace + "/") && workDir !== workspace) {
		throw new Error(`Working directory must be within workspace: ${workDir}`);
	}

	if (!existsSync(workDir)) {
		throw new Error(`Working directory does not exist: ${workDir}`);
	}

	// Load user env vars (API keys, tokens saved via Integrations UI)
	const shellUserEnv: Record<string, string> = {};
	const shellWsDir = join(process.env.WORKSPACE || "/workspace", ".codeck");
	const shellEncryptedEnvPath = join(shellWsDir, ".env.encrypted");
	const shellDotenvPath = join(shellWsDir, ".env");

	if (existsSync(shellEncryptedEnvPath)) {
		try {
			const store = JSON.parse(readFileSync(shellEncryptedEnvPath, "utf-8"));
			for (const v of store.vars || []) {
				if (v.key && v.value) shellUserEnv[v.key] = decryptValue(v.value);
			}
		} catch {
			/* fall through to plaintext */
		}
	}

	if (Object.keys(shellUserEnv).length === 0 && existsSync(shellDotenvPath)) {
		try {
			const content = readFileSync(shellDotenvPath, "utf-8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eqIdx = trimmed.indexOf("=");
				if (eqIdx > 0) {
					const key = trimmed.slice(0, eqIdx).trim();
					const val = trimmed
						.slice(eqIdx + 1)
						.trim()
						.replace(/^["']|["']$/g, "");
					if (key && val) shellUserEnv[key] = val;
				}
			}
		} catch {
			/* non-fatal */
		}
	}

	const finalEnv = {
		...buildCleanEnv(),
		...shellUserEnv,
		TERM: "xterm-256color",
	};

	console.log(`[Console] Shell: step1 env built +${Date.now() - t0}ms`);

	let pty: IPty;
	try {
		pty = ptySpawn("/bin/bash", [], {
			name: "xterm-256color",
			cols: 120,
			rows: 30,
			cwd: workDir,
			env: finalEnv,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`[Console] Shell ptySpawn failed: ${msg}`);
		throw new Error(`Failed to spawn shell: ${msg}`);
	}

	console.log(`[Console] Shell: step2 ptySpawn done +${Date.now() - t0}ms`);

	const name = "Shell";
	const session: ConsoleSession = {
		id,
		type: "shell",
		pty,
		cwd: workDir,
		name,
		createdAt: Date.now(),
		outputBuffer: [],
		outputBufferSize: 0,
		attached: false,
	};

	startSessionCapture(id, workDir);
	console.log(`[Console] Shell: step3 capture started +${Date.now() - t0}ms`);

	const shellDataDisposable = pty.onData((data: string) => {
		captureOutput(id, data);
		if (!session.attached) {
			session.outputBuffer.push(data);
			session.outputBufferSize += data.length;
			while (
				session.outputBufferSize > MAX_BUFFER_SIZE &&
				session.outputBuffer.length > 0
			) {
				const dropped = session.outputBuffer.shift()!;
				session.outputBufferSize -= dropped.length;
			}
		}
	});
	session.dataDisposable = shellDataDisposable;

	// Register PTY exit handler at creation time (same as agent sessions)
	pty.onExit(({ exitCode }: { exitCode: number }) => {
		for (const cb of globalSessionExitCallbacks) {
			try {
				cb(id, exitCode);
			} catch {
				/* non-fatal */
			}
		}
		if (sessions.has(id)) {
			destroySession(id);
		}
	});

	sessions.set(id, session);
	saveSessionState("session_created");
	console.log(
		`[Console] Shell: done +${Date.now() - t0}ms id=${id.slice(0, 8)}`,
	);
	return session;
}

export function getSession(id: string): ConsoleSession | undefined {
	return sessions.get(id);
}

export function getSessionCount(): number {
	return sessions.size;
}

export function resizeSession(id: string, cols: number, rows: number): void {
	sessions.get(id)?.pty.resize(cols, rows);
}

export function writeToSession(id: string, data: string): void {
	captureInput(id, data);
	const session = sessions.get(id);
	if (!session) {
		// Session not found — input discarded. If this appears in logs during a freeze,
		// the browser is sending console:input for a session that no longer exists
		// (e.g. PTY exited silently and browser state is stale).
		console.warn(
			`[Console] writeToSession: session ${id.slice(0, 8)} NOT FOUND — input discarded (${data.length}B)`,
		);
		return;
	}
	try {
		session.pty.write(data);
	} catch (e) {
		console.error(
			`[Console] pty.write FAILED for ${id.slice(0, 8)}: ${(e as Error).message} — PTY may be dead`,
		);
	}
}

export function destroySession(id: string): void {
	const session = sessions.get(id);
	if (!session) return;

	endSessionCapture(id);

	// Dispose PTY onData handler to prevent memory leak via closure
	if (session.dataDisposable) {
		session.dataDisposable.dispose();
	}

	// Send SIGTERM first to allow graceful shutdown (flush buffers, close files).
	// Kill before removing from registry so code that checks sessions.has(id)
	// (e.g., detectConversationId poller) sees the session as present until signaled.
	try {
		session.pty.kill("SIGTERM");
	} catch {
		// Process may have already exited
	}

	sessions.delete(id);

	// Force SIGKILL after 2s grace period if still running
	setTimeout(() => {
		try {
			session.pty.kill("SIGKILL");
		} catch {
			// Process already exited — expected
		}
	}, 2000);

	if (!suppressStateSave) saveSessionState("session_destroyed");
}

export function destroyAllSessions(): void {
	suppressStateSave = true;
	for (const [id] of sessions) destroySession(id);
	suppressStateSave = false;
}

export function markSessionAttached(id: string): string[] {
	const session = sessions.get(id);
	if (!session) return [];
	session.attached = true;
	const buffered = session.outputBuffer;
	session.outputBuffer = [];
	session.outputBufferSize = 0;
	return buffered;
}

/**
 * Reset attachment state so PTY output is buffered again.
 * Called when all WS clients disconnect — ensures that output produced while
 * no client is connected is buffered and replayed on the next console:attach.
 */
export function resetSessionAttachment(id: string): void {
	const session = sessions.get(id);
	if (!session) return;
	session.attached = false;
}

export function renameSession(id: string, name: string): boolean {
	const session = sessions.get(id);
	if (!session) return false;
	session.name = name;
	saveSessionState("session_renamed");
	return true;
}

export function listSessions(): Array<{
	id: string;
	type: string;
	cwd: string;
	name: string;
	createdAt: number;
	conversationId?: string;
}> {
	return Array.from(sessions.values()).map((s) => ({
		id: s.id,
		type: s.type,
		cwd: s.cwd,
		name: s.name,
		createdAt: s.createdAt,
		conversationId: s.conversationId,
	}));
}

/**
 * Encode a project path the same way Claude Code does for ~/.claude/projects/.
 * Replaces /, \, :, and spaces with '-'.
 * Uses realpathSync to dereference symlinks — Claude CLI also resolves symlinks,
 * so a cwd like /home/codeck/workspace/codeck (→ /opt/codeck) must encode as -opt-codeck.
 */
function encodeProjectPath(cwd: string): string {
	let absolute = resolve(cwd);
	try {
		absolute = realpathSync(absolute);
	} catch {
		/* path may not exist or resolve */
	}
	return absolute.replace(/[/\\: ]/g, "-");
}

/**
 * Check if a .jsonl file contains at least one real conversation message (async).
 * Reading large .jsonl conversation files synchronously was blocking for 100ms+ per file.
 */
async function hasRealMessagesAsync(filePath: string): Promise<boolean> {
	// Stream the file line-by-line instead of reading the entire thing.
	// Conversation files can be 50-100MB; we only need to find the first
	// user/assistant line to confirm the conversation is real.
	try {
		const { createReadStream } = await import("fs");
		const { createInterface } = await import("readline");
		const rl = createInterface({
			input: createReadStream(filePath, "utf8"),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			if (!line) continue;
			try {
				const d = JSON.parse(line);
				if (d.type === "user" || d.type === "assistant") {
					rl.close();
					return true;
				}
			} catch {
				/* skip malformed lines */
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Find the most recent valid conversation ID for the given cwd (async).
 * Uses async I/O to avoid blocking the event loop — the previous sync version
 * used readdirSync + statSync + readFileSync on every .jsonl file, which blocked
 * for seconds when project directories had many conversation files.
 */
async function findMostRecentConversationAsync(
	cwd: string,
): Promise<string | undefined> {
	const encoded = encodeProjectPath(cwd);
	const projectDir = `${ACTIVE_AGENT.projectsDir}/${encoded}`;
	try {
		const entries = await readdirAsync(projectDir).catch(() => [] as string[]);
		const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));

		const fileStats = await Promise.all(
			jsonlFiles.map(async (f) => {
				try {
					const s = await statAsync(`${projectDir}/${f}`);
					return { name: f, mtime: s.mtimeMs };
				} catch {
					return null;
				}
			}),
		);

		const sorted = fileStats
			.filter((s): s is { name: string; mtime: number } => s !== null)
			.sort((a, b) => b.mtime - a.mtime);

		for (const { name } of sorted) {
			if (await hasRealMessagesAsync(`${projectDir}/${name}`)) {
				return name.replace(".jsonl", "");
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Check if a directory has previous Claude Code conversations that can be resumed.
 */
export async function hasResumableConversations(cwd: string): Promise<boolean> {
	const encoded = encodeProjectPath(cwd);
	const projectDir = `${ACTIVE_AGENT.projectsDir}/${encoded}`;
	try {
		const files = await readdirAsync(projectDir).catch(() => [] as string[]);
		return files.some((f) => f.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

// ── Session Persistence ──

const SESSIONS_STATE_PATH = resolve(
	process.env.WORKSPACE || "/workspace",
	".codeck/state/sessions.json",
);

interface SavedSession {
	id: string;
	type: "agent" | "shell";
	cwd: string;
	name: string;
	reason: string;
	conversationId?: string;
	continuationPrompt?: string;
}

interface SessionsState {
	version: number;
	savedAt: number;
	sessions: SavedSession[];
}

let saveStateTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced session state save — coalesces rapid saves (e.g., during restore of
 * multiple sessions) into a single disk write after 500ms of inactivity.
 */
export function saveSessionState(
	reason: string,
	continuationPrompt?: string,
): void {
	if (saveStateTimer) clearTimeout(saveStateTimer);
	saveStateTimer = setTimeout(() => {
		saveStateTimer = null;
		saveSessionStateNow(reason, continuationPrompt);
	}, 500);
}

function saveSessionStateNow(
	reason: string,
	continuationPrompt?: string,
): SessionsState {
	const saved: SavedSession[] = [];
	for (const [, session] of sessions) {
		saved.push({
			id: session.id,
			type: session.type,
			cwd: session.cwd,
			name: session.name,
			reason,
			conversationId:
				session.type === "agent" ? session.conversationId : undefined,
			continuationPrompt:
				session.type === "agent" ? continuationPrompt : undefined,
		});
	}
	const state: SessionsState = {
		version: 1,
		savedAt: Date.now(),
		sessions: saved,
	};

	// If there are no sessions to save, remove the file entirely instead of writing an empty
	// state. This prevents phantom restore cycles: an empty sessions.json would cause
	// hasSavedSessions()=true on next startup, leading to a restore with 0 sessions and a
	// stuck "Restoring sessions..." overlay.
	if (saved.length === 0) {
		try {
			unlinkSync(SESSIONS_STATE_PATH);
		} catch {
			/* already gone */
		}
		console.log(
			`[Console] Removed sessions state (reason: ${reason}): no sessions to persist`,
		);
		return state;
	}

	const dir = resolve(SESSIONS_STATE_PATH, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	atomicWriteFileSync(SESSIONS_STATE_PATH, JSON.stringify(state, null, 2));

	const detail = saved
		.map(
			(s) =>
				`${s.id.slice(0, 8)}(conv:${s.conversationId?.slice(0, 8) || "none"})`,
		)
		.join(", ");
	console.log(
		`[Console] Saved ${saved.length} sessions (reason: ${reason}): ${detail || "none"}`,
	);
	return state;
}

// Session restore disabled — caused persistent black screen bugs after container restart.
// Users restore sessions manually via "recent conversations" or "new agent".
// The save mechanism is kept so sessions.json has data, but restore is never triggered.
export function hasSavedSessions(): boolean {
	return false; // Always false — restore disabled
}

export function isPendingRestore(): boolean {
	return false; // Always false — restore disabled
}

export function clearPendingRestore(): void {
	// no-op
}

/**
 * Read saved sessions from disk WITHOUT creating PTY processes.
 * Returns the list for the frontend to show Resume/Discard prompt.
 * PTY creation happens only when the user explicitly calls restoreSessionsNow().
 */
export function readSavedSessions(): Array<{
	id: string;
	type: string;
	cwd: string;
	name: string;
	conversationId?: string;
}> {
	if (!existsSync(SESSIONS_STATE_PATH)) return [];

	let state: SessionsState;
	try {
		const raw = JSON.parse(readFileSync(SESSIONS_STATE_PATH, "utf8"));
		state = {
			version: raw.version || 1,
			savedAt: raw.savedAt || Date.now(),
			sessions: raw.sessions || [],
		};
	} catch (e) {
		console.log(
			"[Console] Failed to parse sessions.json:",
			(e as Error).message,
		);
		return [];
	}

	console.log(
		`[Console] Found ${state.sessions.length} saved sessions (deferred — waiting for user action)`,
	);

	const result = state.sessions.map((s) => ({
		id: s.id,
		type: s.type || "agent",
		cwd: s.cwd,
		name: s.name || s.cwd.split("/").pop() || "session",
		conversationId: s.conversationId,
	}));

	// Rename to .bak so it doesn't re-trigger on next restart
	try {
		renameSync(SESSIONS_STATE_PATH, SESSIONS_STATE_PATH + ".bak");
	} catch {
		try {
			unlinkSync(SESSIONS_STATE_PATH);
		} catch {
			/* ignore */
		}
	}

	return result;
}

/**
 * Actually create PTY processes for saved sessions.
 * Called when the user clicks "Resume" in the frontend.
 */
export async function restoreSessionsNow(
	savedSessions: Array<{
		type: string;
		cwd: string;
		name: string;
		conversationId?: string;
	}>,
): Promise<
	Array<{
		id: string;
		type: string;
		cwd: string;
		name: string;
	}>
> {
	console.log(
		`[Console] User chose Resume — creating ${savedSessions.length} sessions...`,
	);
	const restored: Array<{
		id: string;
		type: string;
		cwd: string;
		name: string;
	}> = [];

	for (const saved of savedSessions) {
		try {
			const cwd = existsSync(saved.cwd) ? saved.cwd : "/workspace";
			if (saved.type === "agent") {
				let session: ConsoleSession;
				if (saved.conversationId) {
					session = createConsoleSession({
						cwd,
						resume: true,
						conversationId: saved.conversationId,
					});
				} else {
					// Async — avoids blocking the event loop with sync stat/readFile
					const recentConvId = await findMostRecentConversationAsync(cwd);
					if (recentConvId) {
						session = createConsoleSession({
							cwd,
							resume: true,
							conversationId: recentConvId,
						});
					} else {
						session = createConsoleSession({ cwd });
					}
				}
				restored.push({
					id: session.id,
					type: session.type,
					cwd: session.cwd,
					name: session.name,
				});
			} else {
				const session = createShellSession(cwd);
				restored.push({
					id: session.id,
					type: session.type,
					cwd: session.cwd,
					name: session.name,
				});
			}
		} catch (e) {
			console.warn(
				`[Console] Failed to restore session: ${(e as Error).message}`,
			);
		}
	}

	// .bak rename already handled by readSavedSessions() — no duplicate rename needed

	console.log(
		`[Console] Restored ${restored.length}/${savedSessions.length} sessions`,
	);
	return restored;
}

/**
 * Safely update the agent CLI binary and re-resolve the path.
 * Returns the new version string or throws on failure.
 * Async to avoid blocking the event loop during npm install (5-30s).
 */
export async function updateAgentBinary(): Promise<{
	version: string;
	binaryPath: string;
}> {
	const pkg = "@anthropic-ai/claude-code";

	// Run npm update (async — does not block event loop)
	console.log(`[Console] Updating ${pkg}...`);
	try {
		await execFile("npm", ["install", "-g", `${pkg}@latest`], {
			encoding: "utf8",
			timeout: 120000,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Update failed: ${msg}`);
	}

	// Re-resolve binary path
	const oldPath = getAgentBinaryPath();
	const newPath = resolveAgentBinary();
	setAgentBinaryPath(newPath);
	console.log(`[Console] Binary re-resolved: ${oldPath} → ${newPath}`);

	// Validate the new binary works
	let version = "unknown";
	try {
		const result = await execFile(newPath, [ACTIVE_AGENT.flags.version], {
			encoding: "utf8",
			timeout: 10000,
		});
		version = result.stdout.trim();
	} catch {
		console.warn("[Console] Could not get version after update");
	}

	console.log(`[Console] Update complete: ${version} at ${newPath}`);
	return { version, binaryPath: newPath };
}
