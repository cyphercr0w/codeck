import { parentPort } from "worker_threads";
import { createWriteStream, statSync, mkdirSync, existsSync } from "fs";
import { stripVTControlCharacters } from "util";
import type { WriteStream } from "fs";

const MAX_TRANSCRIPT_SIZE = 50 * 1024 * 1024;

// Inlined from session-writer.ts — keep in sync if sanitizeSecrets changes there
function sanitizeSecrets(str: string): string {
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

function stripAnsi(str: string): string {
	return stripVTControlCharacters(str);
}

interface WorkerSession {
	stream: WriteStream;
	path: string;
	lineCount: number;
	sizeLimitReached: boolean;
}

const sessions = new Map<string, WorkerSession>();

function findSessionId(session: WorkerSession): string {
	for (const [id, s] of sessions) {
		if (s === session) return id;
	}
	return "unknown";
}

function writeLine(session: WorkerSession, obj: Record<string, unknown>): void {
	if (session.sizeLimitReached) return;

	if (session.lineCount > 0 && session.lineCount % 100 === 0) {
		try {
			const { size } = statSync(session.path);
			if (size > MAX_TRANSCRIPT_SIZE) {
				session.sizeLimitReached = true;
				session.stream.write(
					JSON.stringify({
						ts: Date.now(),
						role: "system",
						event: "size_limit_reached",
						maxBytes: MAX_TRANSCRIPT_SIZE,
					}) + "\n",
				);
				parentPort?.postMessage({
					type: "sizeLimitReached",
					sessionId: findSessionId(session),
				});
				return;
			}
		} catch {
			/* continue */
		}
	}

	const ok = session.stream.write(JSON.stringify(obj) + "\n");
	session.lineCount++;

	if (!ok) {
		session.stream.once("drain", () => {
			/* ready */
		});
	}
}

parentPort?.on(
	"message",
	(msg: { type: string; sessionId: string; [key: string]: unknown }) => {
		switch (msg.type) {
			case "open": {
				const { sessionId, path, cwd, sessionsDir } = msg as {
					type: string;
					sessionId: string;
					path: string;
					cwd: string;
					sessionsDir: string;
				};
				if (!existsSync(sessionsDir)) {
					mkdirSync(sessionsDir, { recursive: true });
				}
				const stream = createWriteStream(path, { flags: "a" });
				stream.on("error", (err) => {
					parentPort?.postMessage({
						type: "streamError",
						sessionId,
						error: err.message,
					});
					sessions.delete(sessionId);
					if (!stream.destroyed) {
						try {
							stream.close();
						} catch {
							/* already closing */
						}
					}
				});
				const session: WorkerSession = {
					stream,
					path,
					lineCount: 0,
					sizeLimitReached: false,
				};
				sessions.set(sessionId, session);
				writeLine(session, {
					ts: Date.now(),
					role: "system",
					event: "start",
					cwd,
				});
				break;
			}
			case "flush": {
				const { sessionId, role, buffer, ts } = msg as {
					type: string;
					sessionId: string;
					role: string;
					buffer: string;
					ts: number;
				};
				const session = sessions.get(sessionId);
				if (!session || session.sizeLimitReached) return;
				const clean = sanitizeSecrets(stripAnsi(buffer));
				if (clean.trim()) {
					writeLine(session, { ts, role, data: clean });
				}
				break;
			}
			case "writeLine": {
				const { sessionId, obj } = msg as {
					type: string;
					sessionId: string;
					obj: Record<string, unknown>;
				};
				const session = sessions.get(sessionId);
				if (session) writeLine(session, obj);
				break;
			}
			case "close": {
				const { sessionId, endObj } = msg as {
					type: string;
					sessionId: string;
					endObj: Record<string, unknown>;
				};
				const session = sessions.get(sessionId);
				if (session) {
					writeLine(session, endObj);
					session.stream.end();
					sessions.delete(sessionId);
				}
				break;
			}
		}
	},
);
