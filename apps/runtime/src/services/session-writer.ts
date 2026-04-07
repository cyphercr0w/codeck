import { createWriteStream, existsSync, mkdirSync, statSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import { stripVTControlCharacters } from "util";
import type { WriteStream } from "fs";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { dirname, join as pathJoin } from "path";
import { PATHS } from "./memory.js";

const MAX_TRANSCRIPT_SIZE = 50 * 1024 * 1024; // 50MB per session transcript

interface ActiveCapture {
	stream: WriteStream | null; // null when worker thread owns the stream
	path: string;
	inputBuffer: string;
	outputBuffer: string;
	outputTimer: ReturnType<typeof setTimeout> | null;
	inputTimer: ReturnType<typeof setTimeout> | null;
	lineCount: number;
	paused: boolean;
	sizeLimitReached: boolean;
}

const captures = new Map<string, ActiveCapture>();

let outputWorker: Worker | null = null;
let workerFailCount = 0;
const MAX_WORKER_RETRIES = 3;

function getWorker(): Worker | null {
	if (workerFailCount >= MAX_WORKER_RETRIES) return null;
	if (!outputWorker) {
		try {
			const workerPath = pathJoin(
				dirname(fileURLToPath(import.meta.url)),
				"output-worker.js",
			);
			outputWorker = new Worker(workerPath);
			outputWorker.on("message", handleWorkerMessage);
			outputWorker.on("error", (err) => {
				console.error("[SessionWriter] output-worker error:", err.message);
				workerFailCount++;
				outputWorker = null;
				if (workerFailCount >= MAX_WORKER_RETRIES) {
					console.warn(
						`[SessionWriter] Worker failed ${MAX_WORKER_RETRIES} times, falling back to sync I/O permanently`,
					);
				}
			});
			outputWorker.on("exit", (code) => {
				if (code !== 0) {
					console.error("[SessionWriter] output-worker exited with code", code);
					workerFailCount++;
					if (workerFailCount >= MAX_WORKER_RETRIES) {
						console.warn(
							`[SessionWriter] Worker failed ${MAX_WORKER_RETRIES} times, falling back to sync I/O permanently`,
						);
					}
				}
				outputWorker = null;
			});
		} catch (e) {
			console.error(
				"[SessionWriter] Failed to start output-worker:",
				(e as Error).message,
			);
			workerFailCount++;
		}
	}
	return outputWorker;
}

function handleWorkerMessage(msg: { type: string; sessionId: string }): void {
	if (msg.type === "sizeLimitReached") {
		const capture = captures.get(msg.sessionId);
		if (capture) {
			capture.sizeLimitReached = true;
			console.warn(
				`[SessionWriter] Worker reports size limit reached for ${msg.sessionId}`,
			);
		}
	} else if (msg.type === "streamError") {
		const capture = captures.get(msg.sessionId);
		if (capture) {
			console.error(`[SessionWriter] Worker stream error for ${msg.sessionId}`);
			captures.delete(msg.sessionId);
		}
	}
}

function findCaptureId(capture: ActiveCapture): string | undefined {
	for (const [id, c] of captures) {
		if (c === capture) return id;
	}
	return undefined;
}

// Strip ANSI escape sequences using Node.js built-in (covers CSI, OSC, and 8-bit sequences)
function stripAnsi(str: string): string {
	return stripVTControlCharacters(str);
}

// Sanitize secrets/tokens before logging
// Matches common token patterns: Bearer tokens, API keys, OAuth tokens, JWTs, hex secrets
export function sanitizeSecrets(str: string): string {
	return (
		str
			// Bearer tokens (case-insensitive)
			.replace(/(?:bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
			// Key-value pairs: token=..., api_key="...", password: ...
			.replace(
				/(token|api[_-]?key|secret|password|auth|credential)[=:"'\s]+[A-Za-z0-9\-._~+/]{20,}/gi,
				"$1=[REDACTED]",
			)
			// JWTs (eyJ header.payload.signature)
			.replace(
				/eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]*/g,
				"[JWT_REDACTED]",
			)
			// Platform-specific key prefixes (GitHub, Stripe, npm, GitLab, Netlify, etc.)
			.replace(
				/(?:sk|pk|rk|ak|ghp|gho|ghr|ghs|ghu|github_pat|glpat|npm_|nps_|pypi-AgEIcH)[-_][A-Za-z0-9\-_]{16,}/g,
				"[KEY_REDACTED]",
			)
			// Anthropic keys (sk-ant-...)
			.replace(/sk-ant-[A-Za-z0-9\-]{20,}/g, "[KEY_REDACTED]")
			// SendGrid keys (SG....)
			.replace(
				/SG\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}/g,
				"[KEY_REDACTED]",
			)
			// DigitalOcean tokens (do_v1_...)
			.replace(/do_v1_[A-Fa-f0-9]{64}/g, "[KEY_REDACTED]")
			// HuggingFace tokens (hf_...)
			.replace(/hf_[A-Za-z0-9]{20,}/g, "[KEY_REDACTED]")
			// Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-)
			.replace(/xox[bpar]-[A-Za-z0-9\-]{20,}/g, "[KEY_REDACTED]")
			// AWS access keys (AKIA...)
			.replace(/AKIA[A-Z0-9]{16}/g, "[AWS_KEY_REDACTED]")
			// AWS secret keys (often 40 chars base64-ish after key= or similar context)
			.replace(
				/(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[=:"'\s]+[A-Za-z0-9/+=]{30,}/gi,
				"$1=[REDACTED]",
			)
			// Database connection strings
			.replace(/:\/\/[^:]+:[^@]+@/g, "://[CREDENTIALS_REDACTED]@")
			// PEM private keys
			.replace(
				/-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
				"[PRIVATE_KEY_REDACTED]",
			)
			// OpenSSH private keys (ed25519, etc.)
			.replace(
				/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
				"[PRIVATE_KEY_REDACTED]",
			)
			// Embedded git credentials (x-access-token, oauth2, etc. in URLs)
			.replace(/:\/\/x-access-token:[^@]+@/g, "://x-access-token:[REDACTED]@")
			.replace(/:\/\/oauth2:[^@]+@/g, "://oauth2:[REDACTED]@")
	);
}

function writeLine(capture: ActiveCapture, obj: Record<string, unknown>): void {
	if (capture.sizeLimitReached || !capture.stream) return;

	// Check file size every 100 lines
	if (capture.lineCount > 0 && capture.lineCount % 100 === 0) {
		try {
			const { size } = statSync(capture.path);
			if (size > MAX_TRANSCRIPT_SIZE) {
				capture.sizeLimitReached = true;
				capture.stream.write(
					JSON.stringify({
						ts: Date.now(),
						role: "system",
						event: "size_limit_reached",
						maxBytes: MAX_TRANSCRIPT_SIZE,
					}) + "\n",
				);
				console.warn(
					`[SessionWriter] Transcript ${capture.path} exceeded ${MAX_TRANSCRIPT_SIZE} bytes, stopping capture`,
				);
				return;
			}
		} catch {
			/* stat failure — continue writing */
		}
	}

	const ok = capture.stream.write(JSON.stringify(obj) + "\n");
	capture.lineCount++;

	// Backpressure: pause further writes until stream drains
	if (!ok) {
		capture.paused = true;
		capture.stream.once("drain", () => {
			capture.paused = false;
		});
	}
}

export function startSessionCapture(id: string, cwd: string): void {
	const sessionsDir = PATHS.SESSIONS_DIR;
	const filename = `${id}.jsonl`;
	const filepath = join(sessionsDir, filename);

	const worker = getWorker();
	if (worker) {
		const capture: ActiveCapture = {
			stream: null,
			path: filepath,
			inputBuffer: "",
			outputBuffer: "",
			outputTimer: null,
			inputTimer: null,
			lineCount: 0,
			paused: false,
			sizeLimitReached: false,
		};
		captures.set(id, capture);
		worker.postMessage({
			type: "open",
			sessionId: id,
			path: filepath,
			cwd,
			sessionsDir,
		});
		console.log(`[SessionWriter] Started capture for ${id} (worker thread)`);
	} else {
		if (!existsSync(sessionsDir)) {
			mkdirSync(sessionsDir, { recursive: true });
		}
		const stream = createWriteStream(filepath, { flags: "a" });
		stream.on("error", (err) => {
			console.error(
				`[SessionWriter] Write error for ${id}: ${err.message} — stopping capture`,
			);
			captures.delete(id);
			if (!stream.destroyed) {
				try {
					stream.close();
				} catch {
					/* already closing */
				}
			}
		});
		const capture: ActiveCapture = {
			stream,
			path: filepath,
			inputBuffer: "",
			outputBuffer: "",
			outputTimer: null,
			inputTimer: null,
			lineCount: 0,
			paused: false,
			sizeLimitReached: false,
		};
		captures.set(id, capture);
		writeLine(capture, { ts: Date.now(), role: "system", event: "start", cwd });
		console.log(`[SessionWriter] Started capture for ${id} (sync fallback)`);
	}
}

export function captureInput(id: string, data: string): void {
	const capture = captures.get(id);
	if (!capture || capture.paused || capture.sizeLimitReached) return;

	capture.inputBuffer += data;

	// Flush on newline
	if (
		capture.inputBuffer.includes("\n") ||
		capture.inputBuffer.includes("\r")
	) {
		flushInput(capture, id);
		return;
	}

	// Debounce: flush after 2s of no input
	if (capture.inputTimer) clearTimeout(capture.inputTimer);
	capture.inputTimer = setTimeout(() => flushInput(capture, id), 2000);
}

function flushInput(capture: ActiveCapture, id?: string): void {
	if (capture.inputTimer) {
		clearTimeout(capture.inputTimer);
		capture.inputTimer = null;
	}
	if (!capture.inputBuffer) return;

	const sessionId = id ?? findCaptureId(capture);
	const worker = getWorker();
	if (worker && sessionId) {
		worker.postMessage({
			type: "flush",
			sessionId,
			role: "input",
			buffer: capture.inputBuffer,
			ts: Date.now(),
		});
	} else {
		const clean = sanitizeSecrets(stripAnsi(capture.inputBuffer).trim());
		if (clean) {
			writeLine(capture, { ts: Date.now(), role: "input", data: clean });
		}
	}
	capture.inputBuffer = "";
}

// Compaction detection patterns
const COMPACTION_PATTERNS = [
	/auto-compact/i,
	/context.*compact/i,
	/summariz.*context/i,
	/compacting.*conversation/i,
	/context.*window.*full/i,
];

let compactionCallback: ((sessionId: string) => void) | null = null;

export function onCompactionDetected(cb: (sessionId: string) => void): void {
	compactionCallback = cb;
}

export function captureOutput(id: string, data: string): void {
	const capture = captures.get(id);
	if (!capture || capture.sizeLimitReached) return;

	capture.outputBuffer += data;

	// Compaction detection disabled — the broad regex patterns produced too many
	// false positives (matching normal Claude output text like "context", "compact").
	// The FREEZE DETECTED diagnostic in websocket.ts is more reliable.

	// Flush every 500ms or 2KB
	if (capture.outputBuffer.length >= 2048) {
		flushOutput(capture, id);
		return;
	}

	if (capture.outputTimer) clearTimeout(capture.outputTimer);
	capture.outputTimer = setTimeout(() => flushOutput(capture, id), 500);
}

function flushOutput(capture: ActiveCapture, id?: string): void {
	if (capture.outputTimer) {
		clearTimeout(capture.outputTimer);
		capture.outputTimer = null;
	}
	if (!capture.outputBuffer) return;

	const sessionId = id ?? findCaptureId(capture);
	const worker = getWorker();
	if (worker && sessionId) {
		worker.postMessage({
			type: "flush",
			sessionId,
			role: "output",
			buffer: capture.outputBuffer,
			ts: Date.now(),
		});
	} else {
		const clean = sanitizeSecrets(stripAnsi(capture.outputBuffer));
		if (clean.trim()) {
			writeLine(capture, { ts: Date.now(), role: "output", data: clean });
		}
	}
	capture.outputBuffer = "";
}

export function endSessionCapture(id: string): void {
	const capture = captures.get(id);
	if (!capture) return;

	if (capture.outputTimer) clearTimeout(capture.outputTimer);
	if (capture.inputTimer) clearTimeout(capture.inputTimer);

	// Flush remaining buffers
	if (capture.outputBuffer) flushOutput(capture, id);
	if (capture.inputBuffer) flushInput(capture, id);

	const endObj = {
		ts: Date.now(),
		role: "system",
		event: "end",
		lines: capture.lineCount,
	};
	const worker = getWorker();
	if (worker) {
		worker.postMessage({ type: "close", sessionId: id, endObj });
	} else {
		writeLine(capture, endObj);
		capture.stream?.end();
	}
	captures.delete(id);

	console.log(`[SessionWriter] Ended capture for ${id}`);
}

// ── Session listing/reading for API ──

export async function listSessionFiles(): Promise<
	{ id: string; size: number; createdAt: number }[]
> {
	if (!existsSync(PATHS.SESSIONS_DIR)) return [];
	const files = await readdir(PATHS.SESSIONS_DIR);
	const results: { id: string; size: number; createdAt: number }[] = [];
	for (const f of files) {
		if (!f.endsWith(".jsonl")) continue;
		const s = await stat(join(PATHS.SESSIONS_DIR, f));
		results.push({
			id: f.replace(".jsonl", ""),
			size: s.size,
			createdAt: s.birthtimeMs || s.ctimeMs,
		});
	}
	return results.sort((a, b) => b.createdAt - a.createdAt);
}

export async function readSessionTranscript(
	id: string,
): Promise<{ exists: boolean; lines: string[] | null }> {
	const safeId = id.replace(/[^a-zA-Z0-9_\-]/g, "");
	const filePath = join(PATHS.SESSIONS_DIR, `${safeId}.jsonl`);
	if (!existsSync(filePath)) return { exists: false, lines: null };
	const content = await readFile(filePath, "utf-8");
	const lines = content.split("\n").filter(Boolean);
	return { exists: true, lines };
}

export async function getSessionSummary(
	id: string,
): Promise<{ exists: boolean; summary: Record<string, unknown> | null }> {
	const safeId = id.replace(/[^a-zA-Z0-9_\-]/g, "");
	const filePath = join(PATHS.SESSIONS_DIR, `${safeId}.jsonl`);
	if (!existsSync(filePath)) return { exists: false, summary: null };

	const content = await readFile(filePath, "utf-8");
	const lines = content.split("\n").filter(Boolean);

	let startTs = 0;
	let endTs = 0;
	let cwd = "";
	const lineCount = lines.length;

	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			if (obj.role === "system" && obj.event === "start") {
				startTs = obj.ts;
				cwd = obj.cwd || "";
			}
			if (obj.role === "system" && obj.event === "end") {
				endTs = obj.ts;
			}
		} catch {
			/* skip malformed lines */
		}
	}

	return {
		exists: true,
		summary: {
			id: safeId,
			cwd,
			startTs,
			endTs,
			duration: endTs && startTs ? endTs - startTs : null,
			lines: lineCount,
		},
	};
}
