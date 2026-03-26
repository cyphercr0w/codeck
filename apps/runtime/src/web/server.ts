import express from "express";
import compression from "compression";
import helmet from "helmet";
import { createServer } from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, writeFileSync } from "fs";
import v8 from "v8";
import { installLogInterceptor, getLogBuffer, broadcast } from "./logger.js";
import { setupWebSocket, handleWsUpgrade } from "./websocket.js";
import { setupInternalPty, handlePtyUpgrade } from "./internal-pty.js";
import {
	isPasswordConfigured,
	setupPassword,
	validatePassword,
	validateSession,
	invalidateSession,
	changePassword,
	getActiveSessions,
	revokeSessionById,
	getAuthLog,
	loadLockouts,
	saveLockouts,
	createWsTicket,
	type LockoutEntry,
} from "../services/auth.js";
import {
	getClaudeStatus,
	isClaudeAuthenticated,
	getAccountInfo,
	startTokenRefreshMonitor,
	stopTokenRefreshMonitor,
} from "../services/auth-anthropic.js";
import { ACTIVE_AGENT } from "../services/agent.js";
import { getGitStatus, updateClaudeMd, initGitHub } from "../services/git.js";
import {
	destroyAllSessions,
	hasSavedSessions,
	readSavedSessions,
	restoreSessionsNow,
	saveSessionState,
	updateAgentBinary,
	clearPendingRestore,
	listSessions,
} from "../services/console.js";
import { getPresetStatus } from "../services/preset.js";
import agentRoutes from "../routes/agent.routes.js";
import githubRoutes from "../routes/github.routes.js";
import cliAuthRoutes from "../routes/cli-auth.routes.js";
import previewRoutes from "../routes/preview.routes.js";
import previewProxy, {
	handlePreviewProxyUpgrade,
	subdomainPreviewMiddleware,
	handleSubdomainPreviewUpgrade,
} from "../routes/preview-proxy.js";
import gitRoutes from "../routes/git.routes.js";
import sshRoutes from "../routes/ssh.routes.js";
import filesRoutes from "../routes/files.routes.js";
import {
	startPortScanner,
	stopPortScanner,
	getActivePorts,
} from "../services/ports.js";
import { initPortManager } from "../services/port-manager.js";
import { startMdns, stopMdns, getLanIP } from "../services/mdns.js";
import { ensureDirectories } from "../services/memory.js";
import {
	initializeIndexer,
	shutdownIndexer,
} from "../services/memory-indexer.js";
import { initializeSearch, shutdownSearch } from "../services/memory-search.js";
import consoleRoutes from "../routes/console.routes.js";
import presetRoutes from "../routes/preset.routes.js";
import memoryRoutes from "../routes/memory.routes.js";
import projectRoutes from "../routes/project.routes.js";
import workspaceRoutes from "../routes/workspace.routes.js";
import dashboardRoutes from "../routes/dashboard.routes.js";
import codeckRoutes from "../routes/codeck.routes.js";
import permissionsRoutes from "../routes/permissions.routes.js";
import systemRoutes from "../routes/system.routes.js";
import proactiveAgentsRoutes from "../routes/agents.routes.js";
import skillsRoutes from "../routes/skills.routes.js";
import mcpRoutes from "../routes/mcp.routes.js";
import hooksRoutes from "../routes/hooks.routes.js";
import flowsRoutes from "../routes/flows.routes.js";
import chatRoutes from "../routes/chat.routes.js";
import {
	initProactiveAgents,
	shutdownProactiveAgents,
} from "../services/proactive-agents.js";
import { initFlowTemplates } from "../services/flows.js";
import {
	initConsolidationCron,
	shutdownConsolidationCron,
} from "../services/memory-consolidation.js";
import {
	initializeEmbeddings,
	shutdownEmbeddings,
} from "../services/embeddings.js";
import { cleanupOldSessions } from "../services/session-summarizer.js";
import { asyncHandler } from "../utils/async-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CODECK_PORT || "80", 10);
// Optional separate port for WebSocket connections (used in gateway mode: runtime WS on 7778)
const WS_PORT = parseInt(process.env.CODECK_WS_PORT || "0", 10) || 0;
// Resolve path to apps/web/dist from apps/runtime/dist/web/
const WEB_DIST = join(__dirname, "../../../web/dist");

/**
 * Ensure MCP servers from the preset mcp.json are registered in Claude Code's .claude.json.
 * Runs at startup (not during preset apply) to avoid timing issues with Claude Code
 * creating .claude.json after the preset writes it.
 */
function ensureMcpServers(): void {
	const home = process.env.HOME || "/root";
	// mcp.json is copied by preset to /root/.claude/mcp.json
	const mcpJsonPath = join(home, ".claude", "mcp.json");
	if (!existsSync(mcpJsonPath)) {
		// Fallback: try the preset template directly
		const templatePath = join(
			__dirname,
			"../templates/presets/default/mcp.json",
		);
		if (!existsSync(templatePath)) return;
		try {
			const template = JSON.parse(readFileSync(templatePath, "utf-8"));
			writeMcpServers(template.mcpServers || {});
		} catch {
			/* non-fatal */
		}
		return;
	}
	try {
		const mcp = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
		writeMcpServers(mcp.mcpServers || {});
	} catch {
		/* non-fatal */
	}
}

function writeMcpServers(servers: Record<string, unknown>): void {
	if (!servers || Object.keys(servers).length === 0) return;

	const claudeJsonPath = join(process.env.HOME || "/root", ".claude.json");
	let claudeJson: Record<string, unknown> = {};
	try {
		if (existsSync(claudeJsonPath)) {
			const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				claudeJson = parsed;
			}
		}
	} catch {
		/* start fresh */
	}

	if (!claudeJson.mcpServers || typeof claudeJson.mcpServers !== "object") {
		claudeJson.mcpServers = {};
	}
	const existing = claudeJson.mcpServers as Record<string, unknown>;

	let added = 0;
	for (const [name, config] of Object.entries(servers)) {
		if (existing[name]) continue;
		existing[name] = config;
		added++;
	}

	if (added > 0) {
		writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
		console.log(`[Startup] Registered ${added} MCP server(s) in .claude.json`);
	}
}

function logMemoryConfig(): void {
	const heapStats = v8.getHeapStatistics();
	const heapLimitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);

	// Read container memory limit from cgroup (if available)
	let containerLimitMB: number | null = null;
	try {
		const raw = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
		if (raw !== "max") {
			containerLimitMB = Math.round(parseInt(raw, 10) / 1024 / 1024);
		}
	} catch {
		// Not in a cgroup-limited container
	}

	if (containerLimitMB) {
		console.log(
			`[Memory] Container limit: ${containerLimitMB}MB, V8 heap limit: ${heapLimitMB}MB`,
		);
	} else {
		console.log(`[Memory] V8 heap limit: ${heapLimitMB}MB`);
	}
}

export async function startWebServer(): Promise<void> {
	process.on("unhandledRejection", (reason) => {
		console.error("[FATAL] Unhandled promise rejection:", reason);
	});

	installLogInterceptor();

	const app = express();
	// Trust the nginx reverse proxy so req.ip uses X-Forwarded-For (real client IP)
	// instead of 127.0.0.1. '1' = one trusted proxy hop (nginx → Express).
	app.set("trust proxy", 1);
	const server = createServer(app);

	// Disable Nagle's algorithm for low-latency terminal I/O
	server.on("connection", (socket) => socket.setNoDelay(true));

	// Subdomain preview — BEFORE everything. When Host is preview-{port}.*
	// (wildcard DNS), proxy the entire request to localhost:{port}.
	app.use(subdomainPreviewMiddleware);

	// Path-based preview proxy — BEFORE helmet. Used for reachability checks
	// and as fallback when subdomain isn't available.
	app.use("/preview-proxy", previewProxy);

	// Security headers FIRST — must apply to ALL responses (static + dynamic)
	app.use(
		helmet({
			// CSP in report-only mode: logs violations to browser console without blocking.
			// This lets us identify issues before switching to enforcing mode.
			contentSecurityPolicy: {
				useDefaults: true,
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'"],
					styleSrc: ["'self'", "'unsafe-inline'"], // Preact inline styles
					imgSrc: ["'self'", "data:", "https:"],
					fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"], // xterm.js fonts
					connectSrc: ["'self'", "ws:", "wss:"], // WebSocket connections
					workerSrc: ["'self'", "blob:"], // xterm.js web workers
					frameSrc: ["'self'", "http://*.localhost:*", "https://*.codeck.xyz"], // preview subdomains
					// canvas rendering used by xterm.js — no special directive needed (canvas is default allowed)
				},
				reportOnly: false, // Enforcing mode — block CSP violations
			},
			// X-Content-Type-Options: nosniff — enabled by helmet defaults
			// X-Frame-Options: DENY — enabled by helmet defaults (frameguard)
			// Disable HSTS — Codeck runs over plain HTTP in a local/LAN environment
			strictTransportSecurity: false,
			// Disable cross-origin isolation headers — they block CDN resources (Google Fonts)
			// and static assets with crossorigin attribute (Vite output)
			crossOriginEmbedderPolicy: false,
			crossOriginResourcePolicy: false,
			crossOriginOpenerPolicy: false,
		}),
	);

	// 65MB limit — supports base64 uploads (images, videos) and memory import archives
	app.use(express.json({ limit: "65mb" }));

	// Internal health endpoint — used by daemon for runtime health checks
	// Registered before auth middleware; not exposed via /api prefix
	app.get("/internal/status", (_req, res) => {
		res.json({ status: "ok", uptime: process.uptime() });
	});

	// Health endpoint for frontend WS pre-flight (works in both isolated and managed mode)
	app.get("/api/runtime/health", (_req, res) => {
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
		res.json({ ready: true });
	});

	// Preview proxy — mounted before auth so the iframe can load without Bearer token.
	// (preview-proxy mounted above, before helmet)

	// Managed mode: redirect direct browser access to the daemon port.
	// The daemon proxy always sets X-Codeck-Internal, so its absence means direct access.
	const DAEMON_PORT = process.env.CODECK_DAEMON_PORT;
	const MANAGED_SECRET = process.env.CODECK_INTERNAL_SECRET;
	if (DAEMON_PORT && MANAGED_SECRET) {
		app.use((req, res, next) => {
			// Let API, internal, and daemon-proxied requests through
			if (req.path.startsWith("/api") || req.path.startsWith("/internal"))
				return next();
			if (req.headers["x-codeck-internal"] === MANAGED_SECRET) return next();
			// Direct browser access — redirect to daemon
			const portSuffix = DAEMON_PORT === "80" ? "" : `:${DAEMON_PORT}`;
			res.redirect(`http://${req.hostname}${portSuffix}${req.originalUrl}`);
		});
	}

	// Compress all responses (JS/CSS/JSON) — reduces 483KB JS bundle to ~126KB over the wire.
	// Level 1 = fastest compression, minimal CPU overhead. Threshold 1KB skips tiny responses.
	app.use(compression({ level: 1, threshold: 1024 }));

	// Hashed assets (JS/CSS) get long cache; index.html always revalidates
	app.use(
		express.static(WEB_DIST, {
			setHeaders(res, filePath) {
				if (filePath.endsWith(".html")) {
					res.setHeader("Cache-Control", "no-cache");
				} else if (filePath.includes("/assets/")) {
					res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
				}
			},
		}),
	);

	// Rate Limiting (in-memory, per-route groups with stale IP cleanup)
	function createRateLimiter(maxRequests: number, windowMs = 60000) {
		const counts = new Map<string, { count: number; resetAt: number }>();

		// Clean up stale entries every 5 minutes
		setInterval(() => {
			const now = Date.now();
			for (const [ip, entry] of counts) {
				if (now > entry.resetAt) counts.delete(ip);
			}
		}, 5 * 60000);

		return (
			req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			const ip = req.ip || "unknown";
			const now = Date.now();
			const entry = counts.get(ip) || { count: 0, resetAt: now + windowMs };
			if (now > entry.resetAt) {
				entry.count = 0;
				entry.resetAt = now + windowMs;
			}
			entry.count++;
			counts.set(ip, entry);
			if (entry.count > maxRequests) {
				res.status(429).json({ error: "Too many requests" });
				return;
			}
			next();
		};
	}

	// CSRF Defense: Sec-Fetch-Site header validation (blocks cross-site requests even with leaked tokens)
	app.use("/api", (req, res, next) => {
		const fetchSite = req.headers["sec-fetch-site"] as string | undefined;
		if (fetchSite === "cross-site") {
			console.warn(
				`[CSRF] Rejected cross-site request: ${req.method} ${req.path}`,
			);
			return res.status(403).json({ error: "Cross-site requests not allowed" });
		}
		// Allow: same-origin, same-site, none (navigation/bookmarks), or absent (old browsers → fallback to Bearer token)
		next();
	});

	// Stricter limit for auth endpoints (brute-force protection)
	app.use("/api/auth", createRateLimiter(10));
	// General API rate limit
	app.use("/api", createRateLimiter(200));

	// Account lockout (brute-force protection beyond rate limiting)
	// Persisted to disk so restarts don't reset lockouts mid-attack.
	const MAX_FAILED_ATTEMPTS = 5;
	const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
	const failedAttempts: Map<string, LockoutEntry> = loadLockouts();

	function checkLockout(ip: string): { locked: boolean; retryAfter?: number } {
		const entry = failedAttempts.get(ip);
		if (!entry) return { locked: false };
		if (Date.now() < entry.lockedUntil) {
			return {
				locked: true,
				retryAfter: Math.ceil((entry.lockedUntil - Date.now()) / 1000),
			};
		}
		failedAttempts.delete(ip);
		return { locked: false };
	}

	function recordFailedLogin(ip: string): void {
		const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
		entry.count++;
		if (entry.count >= MAX_FAILED_ATTEMPTS) {
			entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
			entry.count = 0;
		}
		failedAttempts.set(ip, entry);
		saveLockouts(failedAttempts);
	}

	function clearFailedAttempts(ip: string): void {
		failedAttempts.delete(ip);
		saveLockouts(failedAttempts);
	}

	// Auth Endpoints (public, before middleware)
	app.get("/api/auth/status", (_req, res) => {
		const configured = isPasswordConfigured();
		res.setHeader("Cache-Control", "no-store");
		res.json({ configured });
	});
	app.post("/api/auth/setup", asyncHandler(async (req, res) => {
		if (isPasswordConfigured()) {
			res.status(400).json({ error: "Password already configured" });
			return;
		}
		const { password } = req.body;
		if (!password || password.length < 8) {
			res.status(400).json({ error: "Password must be at least 8 characters" });
			return;
		}
		if (password.length > 256) {
			res
				.status(400)
				.json({ error: "Password must not exceed 256 characters" });
			return;
		}
		res.json(await setupPassword(password, req.ip || "unknown"));
	}));
	app.post("/api/auth/login", asyncHandler(async (req, res) => {
		const ip = req.ip || "unknown";
		const lockout = checkLockout(ip);
		if (lockout.locked) {
			res.status(429).json({
				success: false,
				error: "Too many failed attempts. Try again later.",
				retryAfter: lockout.retryAfter,
			});
			return;
		}
		const result = await validatePassword(req.body.password, ip);
		if (result.success) {
			clearFailedAttempts(ip);
			res.json({ success: true, token: result.token });
		} else {
			recordFailedLogin(ip);
			res.status(401).json({ success: false, error: "Incorrect password" });
		}
	}));
	// WS ticket endpoint — exchange a session token for a short-lived one-time ticket.
	// The ticket is used in the WebSocket URL instead of the session token,
	// avoiding long-lived tokens appearing in proxy logs and browser history.
	app.post("/api/auth/ws-ticket", (req, res) => {
		if (!isPasswordConfigured()) {
			res.json({ ticket: null });
			return;
		}
		const token = req.headers.authorization?.replace("Bearer ", "");
		if (!token || !validateSession(token)) {
			res.status(401).json({ error: "Unauthorized", needsAuth: true });
			return;
		}
		res.json({ ticket: createWsTicket() });
	});

	// Auth Middleware (protects all /api/* below)
	const INTERNAL_SECRET = process.env.CODECK_INTERNAL_SECRET || "";

	app.use("/api", (req, res, next) => {
		if (!isPasswordConfigured()) return next();

		// Health endpoint is public — needed for WS pre-flight in isolated mode
		if (req.path === "/runtime/health") return next();

		// Trusted proxy bypass — daemon has already authenticated the user
		if (INTERNAL_SECRET && req.headers["x-codeck-internal"] === INTERNAL_SECRET)
			return next();

		// Localhost bypass for memory API — agent CLI inside container has full access.
		// Safety: reject if X-Forwarded-For is set, which means the request came through
		// a reverse proxy (e.g. nginx) and is NOT truly local. With trust proxy enabled,
		// req.ip already reflects the real client IP, but X-Forwarded-For presence is an
		// additional signal that the request was proxied from outside.
		// Localhost bypass for internal APIs — agent hooks inside container post here directly.
		const localBypassPaths = [
			"/memory",
			"/console/context",
			"/console/subagents",
			"/flows",
			"/chat",
		];
		if (localBypassPaths.some((p) => req.path.startsWith(p))) {
			const ip = req.ip || "";
			const isLocalIp =
				ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
			const isProxied = !!req.headers["x-forwarded-for"];
			if (isLocalIp && !isProxied) return next();
		}

		// Support token via Bearer header or ?token= query param (for download links)
		const token =
			req.headers.authorization?.replace("Bearer ", "") ||
			(req.query.token as string | undefined);
		if (!token || !validateSession(token)) {
			res.status(401).json({ error: "Unauthorized", needsAuth: true });
			return;
		}
		next();
	});

	// Logout (protected — requires active session to prevent unauthenticated session invalidation)
	app.post("/api/auth/logout", (req, res) => {
		const token = req.headers.authorization?.replace("Bearer ", "");
		if (token) invalidateSession(token);
		res.json({ success: true });
	});

	// Password change (protected — requires active session)
	app.post("/api/auth/change-password", asyncHandler(async (req, res) => {
		const { currentPassword, newPassword } = req.body;
		if (!newPassword || newPassword.length < 8) {
			res
				.status(400)
				.json({ error: "New password must be at least 8 characters" });
			return;
		}
		if (newPassword.length > 256) {
			res
				.status(400)
				.json({ error: "New password must not exceed 256 characters" });
			return;
		}
		const result = await changePassword(currentPassword, newPassword);
		if (result.success) res.json({ success: true, token: result.token });
		else res.status(401).json({ success: false, error: result.error });
	}));

	// Active sessions list
	app.get("/api/auth/sessions", (req, res) => {
		const currentToken = req.headers.authorization?.replace("Bearer ", "");
		res.json({ sessions: getActiveSessions(currentToken) });
	});

	// Revoke a session by ID
	app.delete("/api/auth/sessions/:id", (req, res) => {
		const revoked = revokeSessionById(req.params.id);
		if (!revoked) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		res.json({ success: true });
	});

	// Auth event log
	app.get("/api/auth/log", (_req, res) => {
		res.json({ events: getAuthLog() });
	});

	// Ports (protected — previously public, moved behind auth per AUDIT-14)
	app.get("/api/ports", (_req, res) => {
		res.json(getActivePorts());
	});

	// Status + logs
	app.get("/api/status", (_req, res) => {
		// Bundle everything the frontend needs in ONE response.
		// Eliminates separate /api/account + /api/console/sessions roundtrips (saves 500ms at 250ms latency).
		const sessionList = listSessions();
		const account = isClaudeAuthenticated() ? getAccountInfo() : null;

		res.json({
			claude: getClaudeStatus(),
			git: getGitStatus(),
			preset: getPresetStatus(),
			agent: { name: ACTIVE_AGENT.name, id: ACTIVE_AGENT.id },
			// Bundled data — frontend uses these instead of separate requests
			account: account || undefined,
			sessions: sessionList.length > 0 ? sessionList : undefined,
			pendingRestore:
				hasSavedSessions() && sessionList.length === 0 ? true : undefined,
		});
	});
	app.get("/api/logs", (_req, res) => {
		res.json({ logs: getLogBuffer() });
	});

	// Routes (all protected by auth middleware above)
	app.use("/api/claude", agentRoutes);
	app.use("/api/github", githubRoutes);
	app.use("/api/cli-auth", cliAuthRoutes);
	app.use("/api/preview", previewRoutes);
	app.use("/api/git", gitRoutes);
	app.use("/api/ssh", sshRoutes);
	app.use("/api/files", filesRoutes);
	app.use("/api/console", consoleRoutes);
	app.use("/api/presets", presetRoutes);
	app.use("/api/memory", memoryRoutes);
	app.use("/api/projects", projectRoutes);
	app.use("/api/workspace", workspaceRoutes);
	app.use("/api/dashboard", dashboardRoutes);
	app.use("/api/codeck", codeckRoutes);
	app.use("/api/permissions", permissionsRoutes);
	app.use("/api/system", systemRoutes);
	app.use("/api/agents", proactiveAgentsRoutes);
	app.use("/api/skills", skillsRoutes);
	app.use("/api/mcp-servers", mcpRoutes);
	app.use("/api/hooks", hooksRoutes);
	app.use("/api/flows", flowsRoutes);
	app.use("/api/chat", chatRoutes);

	// Account endpoint
	app.get("/api/account", (_req, res) => {
		res.json({
			authenticated: isClaudeAuthenticated(),
			account: getAccountInfo(),
		});
	});

	// SPA catch-all — serve index.html for all non-API routes (client-side routing)
	app.get("*", (_req, res) => {
		res.sendFile(join(WEB_DIST, "index.html"));
	});

	// Centralized error handler — catch-all for unhandled errors in routes (CWE-209)
	app.use(
		(
			err: Error,
			req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			// Log full error server-side for debugging
			console.error(`[Error] ${req.method} ${req.path}: ${err.message}`);

			// Send sanitized error to client — never expose stack traces or internal paths
			const status = (err as Error & { statusCode?: number }).statusCode || 500;
			const message = status >= 500 ? "Internal server error" : err.message;
			res.status(status).json({ error: message });
		},
	);

	// WebSocket — centralized upgrade routing
	setupWebSocket();
	setupInternalPty();

	// Optional separate WS server (gateway mode: WS on dedicated port)
	let wsServer: ReturnType<typeof createServer> | null = null;
	const upgradeTarget =
		WS_PORT && WS_PORT !== PORT
			? (() => {
					wsServer = createServer((_req, res) => {
						res.writeHead(426, { "Content-Type": "text/plain" });
						res.end("WebSocket upgrade required");
					});
					// Disable Nagle for low-latency terminal I/O on WS port
					wsServer.on("connection", (socket) => socket.setNoDelay(true));
					return wsServer;
				})()
			: server;

	upgradeTarget.on("upgrade", (req, socket, head) => {
		// Subdomain preview WS (wildcard DNS)
		if (
			handleSubdomainPreviewUpgrade(req, socket as import("net").Socket, head)
		) {
			return;
		}
		const pathname = (req.url || "").split("?")[0];
		if (pathname.startsWith("/internal/pty/")) {
			handlePtyUpgrade(req, socket as import("net").Socket, head);
		} else if (pathname.startsWith("/preview-proxy/")) {
			handlePreviewProxyUpgrade(req, socket as import("net").Socket, head);
		} else {
			handleWsUpgrade(req, socket as import("net").Socket, head);
		}
	});

	// Graceful shutdown
	function gracefulShutdown(signal: string): void {
		console.log(`[Server] Received signal ${signal}, shutting down...`);
		saveSessionState("shutdown");
		stopTokenRefreshMonitor();
		shutdownProactiveAgents();
		shutdownConsolidationCron();
		shutdownEmbeddings();
		shutdownSearch();
		shutdownIndexer();
		stopMdns();
		stopPortScanner();
		destroyAllSessions();
		if (wsServer) wsServer.close();
		server.close(() => {
			console.log("[Server] Closed cleanly");
			process.exit(0);
		});
		setTimeout(() => {
			console.log("[Server] Forcing exit");
			process.exit(1);
		}, 5000);
	}

	process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
	process.on("SIGINT", () => gracefulShutdown("SIGINT"));

	server.listen(PORT, () => {
		const lanIP = getLanIP();
		const isLan = lanIP !== "127.0.0.1" && !lanIP.startsWith("172.");
		const portSuffix = PORT === 80 ? "" : `:${PORT}`;
		console.log(`\n🐳 Codeck running`);
		console.log(`   Local: http://localhost${portSuffix}`);
		if (wsServer && WS_PORT) {
			console.log(`   WS:    :${WS_PORT}`);
		}
		if (isLan) {
			console.log(`   LAN:   http://codeck.local${portSuffix}  (${lanIP})`);
		}
		console.log("");
		logMemoryConfig();
		initPortManager();
		initGitHub();
		updateClaudeMd();
		ensureDirectories();
		ensureMcpServers();
		initFlowTemplates();

		// Auto-update agent CLI in background (async — does not block event loop)
		updateAgentBinary()
			.then((result) => {
				console.log(`[Startup] Agent CLI updated: ${result.version}`);
			})
			.catch((e) => {
				console.log(
					`[Startup] Agent CLI update skipped: ${(e as Error).message}`,
				);
			});
		initializeEmbeddings().then(() =>
			initializeIndexer().then(() => initializeSearch()),
		);
		startPortScanner();
		startMdns();
		initProactiveAgents(broadcast);
		startTokenRefreshMonitor(broadcast);
		initConsolidationCron();

		// Daily session transcript cleanup (remove >30 day old JSONL files)
		// Run once at startup and then every 24 hours
		setTimeout(() => cleanupOldSessions(30).catch(() => {}), 60_000);
		setInterval(
			() => cleanupOldSessions(30).catch(() => {}),
			24 * 60 * 60 * 1000,
		);

		// Auto-restore sessions from previous container lifecycle
		if (hasSavedSessions()) {
			const restoreDelayMs = parseInt(
				process.env.SESSION_RESTORE_DELAY || "2000",
				10,
			);
			setTimeout(() => {
				// Read saved sessions WITHOUT creating PTYs — user must choose Resume first
				const saved = readSavedSessions();
				clearPendingRestore();
				broadcast({ type: "sessions:restored", data: saved });
			}, restoreDelayMs);
		}
	});

	// Start separate WS server if configured (gateway mode)
	if (wsServer && WS_PORT) {
		wsServer.listen(WS_PORT, () => {
			console.log(`[Server] WebSocket server listening on :${WS_PORT}`);
		});
	}
}
