import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import {
	getClaudeStatus,
	isClaudeAuthenticated,
	syncCredentialsAfterCLI,
	markTokenExpired,
} from "../services/auth-anthropic.js";
import { ACTIVE_AGENT } from "../services/agent.js";
import {
	listPublicAccounts,
	getDefaultAccountUuid,
} from "../services/accounts.js";
import { getGitStatus, getWorkspacePath } from "../services/git.js";
import {
	getSession,
	writeToSession,
	resizeSession,
	destroySession,
	markSessionAttached,
	resetSessionAttachment,
	listSessions,
	isPendingRestore,
	readSavedSessions,
	onAnySessionExit,
} from "../services/console.js";
import { getLogBuffer, setWsClients, broadcast } from "./logger.js";
import {
	isPasswordConfigured,
	validateSession,
	consumeWsTicket,
} from "../services/auth.js";
import { detectDockerSocketMount } from "../services/environment.js";
import type { Socket } from "net";

const clients = new Set<WebSocket>();

// Track ping/pong liveness per connection (replaces `(ws as any)._isAlive`)
const wsAlive = new WeakMap<WebSocket, boolean>();

// --- Multi-client PTY session tracking ---
// Multiple clients (e.g. PC + mobile) can attach to the same PTY session.
// Output is broadcast to ALL attached clients; resize uses max dimensions.

// sessionId → Set<WebSocket> (all clients attached to this session)
const sessionClients = new Map<string, Set<WebSocket>>();

// sessionId → data disposable (ONE onData handler per session, broadcasts to all clients).
// Disposed when all WS clients disconnect; recreated on next console:attach.
const sessionHandlers = new Map<string, { dispose: () => void }>();
// Track PTY pause state per session for flow control (accessible from close handler)
const sessionPtyPaused = new Map<string, boolean>();

// sessionId → exit disposable (ONE onExit handler per session).
// Kept alive even when no WS clients are connected so PTY death is always detected.
const sessionExitHandlers = new Map<string, { dispose: () => void }>();

// ws → Map<sessionId, { cols, rows }> (per-client dimensions for each session)
const clientDimensions = new Map<
	WebSocket,
	Map<string, { cols: number; rows: number }>
>();

// sessionId → { cols, rows } (current max dimensions applied to PTY)
const sessionMaxDimensions = new Map<string, { cols: number; rows: number }>();

// Max input payload size per WS message (64KB per OWASP recommendation)
const MAX_INPUT_SIZE = 65536;

// Token bucket rate limiter for console:input messages.
// Allows bursts (paste operations) while preventing sustained DoS.
// Normal typing at 60 WPM is ~5 chars/sec, well under the 20/sec refill rate.
// Non-input messages (resize, attach, focus) are never rate-limited.
interface TokenBucket {
	tokens: number;
	lastRefill: number;
}

const BUCKET_SIZE = 100; // max burst capacity
const REFILL_RATE = 20; // tokens per second (1200/min)

const inputBuckets = new Map<WebSocket, TokenBucket>();

function consumeInputToken(ws: WebSocket): boolean {
	let bucket = inputBuckets.get(ws);
	if (!bucket) {
		bucket = { tokens: BUCKET_SIZE, lastRefill: Date.now() };
		inputBuckets.set(ws, bucket);
	}

	// Refill tokens based on elapsed time
	const now = Date.now();
	const elapsed = (now - bucket.lastRefill) / 1000;
	bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + elapsed * REFILL_RATE);
	bucket.lastRefill = now;

	if (bucket.tokens < 1) {
		return false; // drop message silently
	}

	bucket.tokens -= 1;
	return true;
}

let wss: WebSocketServer;

// Auth recovery poller: started when PTY output contains an auth error.
let authRecoveryPoller: ReturnType<typeof setInterval> | null = null;

function startAuthRecoveryPoller(): void {
	if (authRecoveryPoller) return;
	console.log("[WS] Auth recovery poller started (3s interval)");
	authRecoveryPoller = setInterval(() => {
		syncCredentialsAfterCLI();
		if (isClaudeAuthenticated()) {
			console.log(
				"[WS] Auth recovered after re-login — stopping recovery poller",
			);
			clearInterval(authRecoveryPoller!);
			authRecoveryPoller = null;
			broadcastStatus();
		}
	}, 3000);
}

export function setupWebSocket(): void {
	// Register a global session-exit callback so WS cleanup runs for EVERY session
	// exit — even sessions that never had a WS client attached.  This replaces the
	// per-session pty.onExit handler that previously caused double-destroy with the
	// handler in console.ts.
	onAnySessionExit((sessionId: string, exitCode: number) => {
		const currentClients = sessionClients.get(sessionId);
		if (currentClients) {
			const payload = JSON.stringify({
				type: "console:exit",
				sessionId,
				exitCode,
			});
			for (const client of currentClients) {
				if (client.readyState === WebSocket.OPEN) client.send(payload);
			}
		}
		syncCredentialsAfterCLI();
		broadcastStatus();
		sessionExitHandlers.delete(sessionId);
		sessionHandlers.delete(sessionId);
		sessionClients.delete(sessionId);
		sessionMaxDimensions.delete(sessionId);
		sessionPtyPaused.delete(sessionId);
	});

	wss = new WebSocketServer({
		noServer: true,
		maxPayload: 512 * 1024, // 512KB — must fit preview JPEG frames (~100-200KB base64)
		perMessageDeflate: false,
		// Accept auth.* subprotocol so browser doesn't reject the connection
		handleProtocols(protocols) {
			for (const p of protocols) {
				if (p.startsWith("auth.")) return p;
			}
			return false; // no matching protocol — still connects (just without subprotocol)
		},
	});

	// --- Server-side ping/pong keepalive ---
	const pingInterval = setInterval(() => {
		for (const ws of clients) {
			if (wsAlive.get(ws) === false) {
				console.log("[WS] Terminating stale client");
				ws.terminate();
				continue;
			}
			wsAlive.set(ws, false);
			ws.ping();
		}
	}, 30000);

	// Application-level heartbeat for client stale detection.
	// Sent directly to each client (not via broadcast()) so heartbeats
	// are never silently dropped by the backpressure check in broadcast().
	const heartbeatPayload = JSON.stringify({ type: "heartbeat" });
	const heartbeatInterval = setInterval(() => {
		for (const ws of clients) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(heartbeatPayload);
			}
		}
	}, 25000);

	// Monitor Claude auth state — detect token expiry between explicit status broadcasts.
	// When auth is broken, also call syncCredentialsAfterCLI() to catch in-terminal re-login.
	let lastAuthState: boolean | null = null;
	const authMonitorInterval = setInterval(() => {
		if (clients.size === 0) return;
		if (!isClaudeAuthenticated()) {
			syncCredentialsAfterCLI();
		}
		const current = isClaudeAuthenticated();
		if (current !== lastAuthState) {
			lastAuthState = current;
			broadcastStatus();
		}
	}, 15000);

	wss.on("close", () => {
		clearInterval(pingInterval);
		clearInterval(heartbeatInterval);
		clearInterval(authMonitorInterval);
		if (authRecoveryPoller) {
			clearInterval(authRecoveryPoller);
			authRecoveryPoller = null;
		}
	});

	const INTERNAL_SECRET = process.env.CODECK_INTERNAL_SECRET || "";

	wss.on("connection", (ws, req) => {
		// Disable Nagle's algorithm for low-latency terminal I/O.
		// Without this, small packets (single keystrokes) may be delayed up to 40ms
		// waiting for more data to coalesce. On 250ms links this adds perceptible lag.
		const socket = (req as any).socket;
		if (socket?.setNoDelay) socket.setNoDelay(true);

		// Auth validation for WebSocket
		if (isPasswordConfigured()) {
			const url = new URL(req.url || "", `http://${req.headers.host}`);

			const internalParam = url.searchParams.get("_internal");
			const isTrustedProxy =
				INTERNAL_SECRET && internalParam === INTERNAL_SECRET;

			if (!isTrustedProxy) {
				// Try subprotocol auth first (preferred — keeps token out of URL/logs)
				// Format: "auth.<base64url-encoded-token>"
				let token: string | null = null;
				const protocols = req.headers["sec-websocket-protocol"];
				if (protocols) {
					const authProto = protocols
						.split(",")
						.map((p) => p.trim())
						.find((p) => p.startsWith("auth."));
					if (authProto) {
						const encoded = authProto.slice(5); // remove "auth." prefix
						try {
							token = Buffer.from(encoded, "base64url").toString("utf-8");
						} catch {
							/* invalid base64 */
						}
						// Accept the subprotocol so the browser doesn't reject the connection
						// ws library handles this via handleProtocols in the upgrade handler
					}
				}

				// Fallback to query params (backward compat + internal tools)
				if (!token) {
					const ticket = url.searchParams.get("ticket");
					const queryToken = url.searchParams.get("token");
					if (ticket && consumeWsTicket(ticket)) {
						// ticket auth OK
					} else if (queryToken && validateSession(queryToken)) {
						// query token auth OK
					} else {
						ws.close(4001, "Unauthorized");
						return;
					}
				} else if (!validateSession(token)) {
					ws.close(4001, "Unauthorized");
					return;
				}
			}
		}

		wsAlive.set(ws, true);
		ws.on("pong", () => {
			wsAlive.set(ws, true);
		});

		console.log("[WS] Client connected");
		clients.add(ws);
		setWsClients(clients);

		// Initial state + logs + sessions
		ws.send(
			JSON.stringify({
				type: "status",
				data: {
					claude: getClaudeStatus(),
					git: getGitStatus(),
					workspace: getWorkspacePath(),
					agent: { name: ACTIVE_AGENT.name, id: ACTIVE_AGENT.id },
					accounts: listPublicAccounts(),
					defaultAccountUuid: getDefaultAccountUuid(),
					sessions: listSessions(),
					pendingRestore: isPendingRestore(),
					savedSessions: isPendingRestore() ? readSavedSessions() : undefined,
					dockerExperimental: detectDockerSocketMount(),
				},
			}),
		);
		ws.send(JSON.stringify({ type: "logs", data: getLogBuffer() }));

		// Console messages
		ws.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				handleConsoleMessage(ws, msg);
			} catch (e) {
				console.warn(
					"[WS] Failed to parse client message:",
					(e as Error).message,
				);
			}
		});

		ws.on("close", () => {
			console.log("[WS] Client disconnected");
			clients.delete(ws);
			setWsClients(clients);

			for (const [sessionId, clientSet] of sessionClients) {
				clientSet.delete(ws);
				if (clientSet.size === 0) {
					const dataHandler = sessionHandlers.get(sessionId);
					if (dataHandler) {
						dataHandler.dispose();
						sessionHandlers.delete(sessionId);
					}
					resetSessionAttachment(sessionId);
					sessionClients.delete(sessionId);
					sessionMaxDimensions.delete(sessionId);
					sessionPtyPaused.delete(sessionId);
				} else {
					recalcMaxDimensions(sessionId);
					// Resume PTY if the disconnected client was the congested one
					if (sessionPtyPaused.get(sessionId)) {
						const allOk = [...clientSet].every(
							(c) =>
								c.readyState !== WebSocket.OPEN || c.bufferedAmount < 16 * 1024,
						);
						if (allOk) {
							sessionPtyPaused.set(sessionId, false);
							const session = getSession(sessionId);
							if (session) session.pty.resume();
						}
					}
				}
			}
			clientDimensions.delete(ws);
			inputBuckets.delete(ws);
			// Clear active client tracking for this ws
			for (const [sid, activeWs] of sessionActiveClient) {
				if (activeWs === ws) sessionActiveClient.delete(sid);
			}
		});
	});
}

// sessionId → ws (last client that sent input or resize — their dims win)
const sessionActiveClient = new Map<string, WebSocket>();

/**
 * Recalculate PTY dimensions for a session.
 * Strategy: use the dimensions of the client that most recently interacted
 * (sent input or resize). When only one client is connected, always use it.
 * Fallback to max dimensions if no active client is tracked.
 */
function recalcMaxDimensions(sessionId: string): void {
	const clientSet = sessionClients.get(sessionId);
	if (!clientSet || clientSet.size === 0) return;

	// Single client — always use its dimensions
	if (clientSet.size === 1) {
		const [client] = clientSet;
		const dims = clientDimensions.get(client)?.get(sessionId);
		if (dims) applyDimensions(sessionId, dims.cols, dims.rows);
		return;
	}

	// Multiple clients — use the active client's dimensions
	const activeClient = sessionActiveClient.get(sessionId);
	if (activeClient && clientSet.has(activeClient)) {
		const dims = clientDimensions.get(activeClient)?.get(sessionId);
		if (dims) {
			applyDimensions(sessionId, dims.cols, dims.rows);
			return;
		}
	}

	// Fallback: max dimensions
	let maxCols = 1,
		maxRows = 1;
	for (const client of clientSet) {
		const dims = clientDimensions.get(client)?.get(sessionId);
		if (dims) {
			maxCols = Math.max(maxCols, dims.cols);
			maxRows = Math.max(maxRows, dims.rows);
		}
	}
	applyDimensions(sessionId, maxCols, maxRows);
}

function applyDimensions(sessionId: string, cols: number, rows: number): void {
	const prev = sessionMaxDimensions.get(sessionId);
	if (!prev || prev.cols !== cols || prev.rows !== rows) {
		sessionMaxDimensions.set(sessionId, { cols, rows });
		resizeSession(sessionId, cols, rows);
	}
}

function handleConsoleMessage(
	ws: WebSocket,
	msg: {
		type: string;
		sessionId: string;
		data?: string;
		cols?: number;
		rows?: number;
	},
): void {
	// Validate message structure
	if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
	if (
		typeof msg.sessionId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			msg.sessionId,
		)
	)
		return;

	// Validate input data size to prevent memory abuse
	if (
		msg.type === "console:input" &&
		typeof msg.data === "string" &&
		msg.data.length > MAX_INPUT_SIZE
	)
		return;

	// Validate resize bounds
	if (msg.type === "console:resize") {
		const rawC = Number(msg.cols),
			rawR = Number(msg.rows);
		if (
			!Number.isInteger(rawC) ||
			!Number.isInteger(rawR) ||
			rawC < 1 ||
			rawC > 9999 ||
			rawR < 1 ||
			rawR > 9999
		)
			return;
		// Clamp to safe bounds instead of dropping — prevents stale PTY dimensions
		const c = Math.max(10, Math.min(500, rawC));
		const r = Math.max(3, Math.min(200, rawR));
		msg.cols = c;
		msg.rows = r;
	}

	if (msg.type === "console:attach") {
		const session = getSession(msg.sessionId);
		if (!session) {
			ws.send(
				JSON.stringify({
					type: "console:error",
					sessionId: msg.sessionId,
					error: "Session not found",
				}),
			);
			return;
		}

		let clientSet = sessionClients.get(msg.sessionId);
		if (!clientSet) {
			clientSet = new Set();
			sessionClients.set(msg.sessionId, clientSet);
		}
		clientSet.add(ws);

		// Apply pre-stored dimensions before replay so PTY is at correct size
		if (clientDimensions.get(ws)?.has(msg.sessionId)) {
			recalcMaxDimensions(msg.sessionId);
		}

		const sid = msg.sessionId;

		// Data handler: created when the first client attaches
		if (!sessionHandlers.has(sid)) {
			// Watermark-based PTY flow control.
			// Pause PTY when WS buffer exceeds HIGH_WATER, resume when it drops below LOW_WATER.
			// Prevents memory exhaustion and input freeze on fast PTY output.
			const HIGH_WATER = 64 * 1024; // 64KB
			const LOW_WATER = 16 * 1024; // 16KB
			sessionPtyPaused.set(sid, false);

			const dataDisposable = session.pty.onData((data: string) => {
				// Detect OAuth token revocation errors in real-time
				if (
					data.includes("OAuth token revoked") ||
					data.includes("Please run /login")
				) {
					if (isClaudeAuthenticated()) {
						console.log(
							`[WS] Auth error in PTY output for session ${sid.slice(0, 8)} but token is valid — skipping markTokenExpired`,
						);
						startAuthRecoveryPoller();
					} else {
						console.log(
							`[WS] Auth error detected in PTY output for session ${sid.slice(0, 8)} — marking token expired`,
						);
						markTokenExpired();
						broadcastStatus();
						startAuthRecoveryPoller();
					}
				}

				const currentClients = sessionClients.get(sid);
				if (!currentClients) return;

				const clientSnapshot = [...currentClients];
				const payload = JSON.stringify({
					type: "console:output",
					sessionId: sid,
					data,
				});

				// Check backpressure: pause PTY if ANY client buffer exceeds high water
				if (!sessionPtyPaused.get(sid)) {
					for (const client of clientSnapshot) {
						if (
							client.readyState === WebSocket.OPEN &&
							client.bufferedAmount > HIGH_WATER
						) {
							sessionPtyPaused.set(sid, true);
							session.pty.pause();
							break;
						}
					}
				}

				for (const client of clientSnapshot) {
					if (client.readyState === WebSocket.OPEN) {
						client.send(payload, (err) => {
							if (err)
								console.warn("[WS] Send error for session", sid, err.message);
							// Resume only when ALL clients are below low water mark.
							// Use live sessionClients set (not stale clientSnapshot) so
							// disconnected/new clients are correctly accounted for.
							if (sessionPtyPaused.get(sid)) {
								const liveClients = sessionClients.get(sid);
								if (!liveClients || liveClients.size === 0) {
									sessionPtyPaused.set(sid, false);
									session.pty.resume();
								} else {
									const allDrained = [...liveClients].every(
										(c) =>
											c.readyState !== WebSocket.OPEN ||
											c.bufferedAmount < LOW_WATER,
									);
									if (allDrained) {
										sessionPtyPaused.set(sid, false);
										session.pty.resume();
									}
								}
							}
						});
					}
				}
			});
			sessionHandlers.set(sid, dataDisposable);
		}

		// Replay buffered output
		const buffered = markSessionAttached(msg.sessionId);
		for (const chunk of buffered) {
			if (ws.readyState === WebSocket.OPEN)
				ws.send(
					JSON.stringify({
						type: "console:output",
						sessionId: msg.sessionId,
						data: chunk,
					}),
				);
		}
	}

	if (msg.type === "console:focus") {
		// User tapped/clicked the terminal — mark this client as active and
		// resize the PTY to match their dimensions. This is the primary
		// mechanism for mobile/desktop coexistence: whichever device the user
		// interacts with gets the correct terminal dimensions.
		const prevActive = sessionActiveClient.get(msg.sessionId);
		sessionActiveClient.set(msg.sessionId, ws);
		if (prevActive !== ws) recalcMaxDimensions(msg.sessionId);
		return;
	}

	if (msg.type === "console:input") {
		// Token bucket rate limit — drop excess input silently (don't disconnect)
		if (!consumeInputToken(ws)) return;

		// Also track input as active — covers keyboard-only navigation
		const prevActive = sessionActiveClient.get(msg.sessionId);
		sessionActiveClient.set(msg.sessionId, ws);
		if (prevActive && prevActive !== ws) recalcMaxDimensions(msg.sessionId);
		writeToSession(msg.sessionId, msg.data || "");
	}

	if (msg.type === "console:resize") {
		let dims = clientDimensions.get(ws);
		if (!dims) {
			dims = new Map();
			clientDimensions.set(ws, dims);
		}
		dims.set(msg.sessionId, { cols: msg.cols || 80, rows: msg.rows || 24 });

		// Don't mark resize sender as the active client — that would cause
		// mobile connecting to steal dimensions from desktop. Only console:input
		// (actual typing) promotes a client to active. The resize is stored per-client
		// and applied when that client becomes active via typing.
		recalcMaxDimensions(msg.sessionId);
	}
}

/** Handle WebSocket upgrade for the main /ws endpoint (origin validation + auth). */
export function handleWsUpgrade(
	req: IncomingMessage,
	socket: Socket,
	head: Buffer,
): void {
	const origin = req.headers.origin;
	const host = req.headers.host;
	if (origin && host) {
		try {
			const originUrl = new URL(origin);
			const isAllowed =
				originUrl.host === host ||
				originUrl.hostname === "localhost" ||
				originUrl.hostname === "127.0.0.1" ||
				originUrl.hostname === "::1" ||
				originUrl.hostname.endsWith(".local");
			if (!isAllowed) {
				console.warn(
					`[WS] Rejected upgrade: origin "${origin}" does not match host "${host}"`,
				);
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
				return;
			}
		} catch {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
	}

	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
}

export function broadcastStatus(): void {
	broadcast({
		type: "status",
		data: {
			claude: getClaudeStatus(),
			git: getGitStatus(),
			agent: { name: ACTIVE_AGENT.name, id: ACTIVE_AGENT.id },
			accounts: listPublicAccounts(),
			defaultAccountUuid: getDefaultAccountUuid(),
			sessions: listSessions(),
			dockerExperimental: detectDockerSocketMount(),
		},
	});
}
