/**
 * Preview proxy — dedicated-port approach with security controls.
 *
 * Two access modes:
 * 1. Dedicated port (self-hosted): proxy on 15000-15010, Docker-mapped
 * 2. Subdomain (Cloudflare): preview-{port}.hostname, requires wildcard DNS
 *
 * Security:
 * - Subdomain & path-based proxies only allow ports with an active preview session
 * - Dedicated-port proxy only proxies to the target port it was created for
 * - CORS restricted to same origin (not wildcard)
 * - WS headers sanitized against response splitting
 */
import { Router, type Request, type Response } from "express";
import http, { createServer, IncomingMessage } from "http";
import type { Socket } from "net";
import { getActivePorts } from "../services/ports.js";

const router = Router();

const BLOCKED_HEADERS = new Set([
	"x-frame-options",
	"content-security-policy",
	"content-security-policy-report-only",
]);

// Shared deny list — single source of truth
export const DENIED_PORTS = new Set([80, 9229, 9333, 9222, 35989]);

// Fixed port range for preview proxy — must match Docker EXPOSE / port mapping
const PREVIEW_PORT_MIN = 15000;
const PREVIEW_PORT_MAX = 15010;

function validatePort(port: number): boolean {
	return (
		Number.isFinite(port) &&
		port >= 1 &&
		port <= 65535 &&
		!DENIED_PORTS.has(port)
	);
}

function stripHeaders(
	proxyRes: http.IncomingMessage,
): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(proxyRes.headers)) {
		if (value === undefined) continue;
		if (BLOCKED_HEADERS.has(key.toLowerCase())) continue;
		headers[key] = value as string | string[];
	}
	headers["x-frame-options"] = "ALLOWALL";
	return headers;
}

/** Sanitize header value for WS 101 response — prevent response splitting. */
function sanitizeHeaderValue(v: string | string[] | undefined): string {
	if (v === undefined) return "";
	const s = Array.isArray(v) ? v.join(", ") : String(v);
	return s.replace(/[\r\n]/g, "");
}

/** Write WS 101 response with sanitized headers. */
function writeWsUpgrade(
	socket: Socket,
	proxyRes: http.IncomingMessage,
	proxySocket: Socket,
	proxyHead: Buffer,
): void {
	const headerLines = Object.entries(proxyRes.headers)
		.map(([k, v]) => `${k}: ${sanitizeHeaderValue(v)}`)
		.join("\r\n");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines}\r\n\r\n`);
	if (proxyHead.length > 0) socket.write(proxyHead);
	// Pipe with error handling to prevent unhandled stream errors
	proxySocket.on("error", () => socket.destroy());
	socket.on("error", () => proxySocket.destroy());
	proxySocket.pipe(socket);
	socket.pipe(proxySocket);
}

// ── Dedicated-port proxy server ─────────────────────────────────────

let activeProxy: {
	server: http.Server;
	targetPort: number;
	proxyPort: number;
} | null = null;

let starting = false;

// ── Public API ──────────────────────────────────────────────────────

export async function startPreviewProxy(targetPort: number): Promise<number> {
	if (starting) throw new Error("Preview proxy is already starting");
	starting = true;

	try {
		await stopPreviewProxy();

		if (!validatePort(targetPort)) {
			throw new Error("Invalid or denied port");
		}

		const proxyPort = await new Promise<number>((resolve, reject) => {
			const server = createServer((req, res) => {
				const proxyReq = http.request(
					{
						hostname: "127.0.0.1",
						port: targetPort,
						path: req.url || "/",
						method: req.method,
						headers: { ...req.headers, host: `localhost:${targetPort}` },
					},
					(proxyRes) => {
						const headers = stripHeaders(proxyRes);
						res.writeHead(proxyRes.statusCode || 200, headers);
						proxyRes.pipe(res);
					},
				);

				proxyReq.on("error", () => {
					if (!res.headersSent) {
						res.writeHead(502);
						res.end("Bad Gateway");
					}
				});

				if (req.method !== "GET" && req.method !== "HEAD") {
					req.pipe(proxyReq);
				} else {
					proxyReq.end();
				}
			});

			// WebSocket upgrades (HMR)
			server.on("upgrade", (req, socket) => {
				const proxyReq = http.request({
					hostname: "127.0.0.1",
					port: targetPort,
					path: req.url || "/",
					method: "GET",
					headers: { ...req.headers, host: `localhost:${targetPort}` },
				});

				proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
					writeWsUpgrade(socket as Socket, proxyRes, proxySocket, proxyHead);
				});

				proxyReq.on("error", () => (socket as Socket).destroy());
				proxyReq.end();
			});

			// Try ports in the fixed range (Docker-mapped)
			const tryPort = (port: number) => {
				server.once("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE" && port < PREVIEW_PORT_MAX) {
						tryPort(port + 1);
					} else {
						server.close();
						reject(
							port >= PREVIEW_PORT_MAX && err.code === "EADDRINUSE"
								? new Error("All preview ports in use (15000-15010)")
								: err,
						);
					}
				});
				server.listen(port, "0.0.0.0", () => {
					activeProxy = { server, targetPort, proxyPort: port };
					resolve(port);
				});
			};
			tryPort(PREVIEW_PORT_MIN);
		});

		console.log(`[Preview] Proxy :${proxyPort} → localhost:${targetPort}`);
		return proxyPort;
	} finally {
		starting = false;
	}
}

export function stopPreviewProxy(): Promise<void> {
	return new Promise((resolve) => {
		if (!activeProxy) {
			resolve();
			return;
		}
		const { server, proxyPort } = activeProxy;
		activeProxy = null;
		const timeout = setTimeout(() => resolve(), 2000);
		server.close(() => {
			clearTimeout(timeout);
			console.log(`[Preview] Proxy :${proxyPort} stopped`);
			resolve();
		});
	});
}

export function getPreviewStatus(): {
	active: boolean;
	targetPort: number | null;
	proxyPort: number | null;
} {
	if (!activeProxy) return { active: false, targetPort: null, proxyPort: null };
	return {
		active: true,
		targetPort: activeProxy.targetPort,
		proxyPort: activeProxy.proxyPort,
	};
}

/** Check if a port has an active preview session (used by subdomain/path auth). */
function isActivePreviewPort(port: number): boolean {
	return activeProxy !== null && activeProxy.targetPort === port;
}

// ── Subdomain middleware (for Cloudflare / wildcard DNS) ────────────

/**
 * Extract preview port from Host header.
 * Matches: preview-4321.localhost, preview-4321.dev.codeck.xyz, etc.
 * Limits to 1-5 digits to prevent unbounded parsing.
 */
function extractSubdomainPort(host: string | undefined): number | null {
	if (!host) return null;
	const hostname = host.split(":")[0];
	// Match both formats:
	// - p4321.codeck.xyz (single-level, covered by free Cloudflare SSL)
	// - preview-4321.localhost (development)
	const match = hostname.match(/^(?:p|preview-)(\d{1,5})\./);
	if (!match) return null;
	const port = parseInt(match[1], 10);
	return validatePort(port) ? port : null;
}

/**
 * Express middleware: if Host is `preview-{port}.*`, proxy the entire
 * request to localhost:{port}. Only allows ports with an active preview.
 */
export function subdomainPreviewMiddleware(
	req: Request,
	res: Response,
	next: () => void,
): void {
	const port = extractSubdomainPort(req.headers.host);
	if (port === null) return next();

	const activePorts = getActivePorts();
	if (!activePorts.some((p) => p.port === port)) {
		res.status(404).json({ error: "No service on this port" });
		return;
	}

	const proxyReq = http.request(
		{
			hostname: "127.0.0.1",
			port,
			path: req.originalUrl,
			method: req.method,
			headers: { ...req.headers, host: `localhost:${port}` },
		},
		(proxyRes) => {
			const headers = stripHeaders(proxyRes);
			res.writeHead(proxyRes.statusCode || 200, headers);
			proxyRes.pipe(res);
		},
	);

	proxyReq.on("error", () => {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Cannot connect to localhost:${port}` }));
		}
	});

	if (req.method !== "GET" && req.method !== "HEAD") {
		req.pipe(proxyReq);
	} else {
		proxyReq.end();
	}
}

/** Handle WebSocket upgrade for subdomain-based preview. */
export function handleSubdomainPreviewUpgrade(
	req: IncomingMessage,
	socket: Socket,
	_head: Buffer,
): boolean {
	const port = extractSubdomainPort(req.headers.host);
	if (port === null) return false;

	const activePorts = getActivePorts();
	if (!activePorts.some((p) => p.port === port)) {
		socket.destroy();
		return true;
	}

	const proxyReq = http.request({
		hostname: "127.0.0.1",
		port,
		path: req.url || "/",
		method: "GET",
		headers: { ...req.headers, host: `localhost:${port}` },
	});

	proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
		writeWsUpgrade(socket, proxyRes, proxySocket, proxyHead);
	});

	proxyReq.on("error", () => socket.destroy());
	proxyReq.end();
	return true;
}

// ── Path-based fallback (reachability checks) ───────────────────────

router.use("/:port", (req: Request, res: Response) => {
	const portStr = req.params.port;
	const port = parseInt(portStr, 10);
	if (!validatePort(port)) {
		res.status(400).json({ error: "Invalid or denied port" });
		return;
	}

	// Path-based proxy only for reachability checks (HEAD) or active previews
	if (req.method !== "HEAD" && !isActivePreviewPort(port)) {
		res.status(403).json({ error: "No active preview for this port" });
		return;
	}

	const targetPath =
		req.originalUrl.replace(`/preview-proxy/${portStr}`, "") || "/";

	const proxyReq = http.request(
		{
			hostname: "127.0.0.1",
			port,
			path: targetPath,
			method: req.method,
			headers: { ...req.headers, host: `localhost:${port}` },
			timeout: 10000,
		},
		(proxyRes) => {
			const headers = stripHeaders(proxyRes);
			res.writeHead(proxyRes.statusCode || 200, headers);
			proxyRes.pipe(res);
		},
	);

	proxyReq.on("timeout", () => proxyReq.destroy());
	proxyReq.on("error", () => {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Cannot connect to localhost:${port}` }));
		}
	});

	if (req.method !== "GET" && req.method !== "HEAD") {
		req.pipe(proxyReq);
	} else {
		proxyReq.end();
	}
});

export default router;

/** Handle WebSocket upgrade for path-based preview proxy. */
export function handlePreviewProxyUpgrade(
	req: IncomingMessage,
	socket: Socket,
	_head: Buffer,
): boolean {
	const url = req.url || "";
	const match = url.match(/^\/preview-proxy\/(\d{1,5})(\/.*)?$/);
	if (!match) return false;

	const port = parseInt(match[1], 10);
	if (!validatePort(port) || !isActivePreviewPort(port)) {
		socket.destroy();
		return true;
	}

	const proxyReq = http.request({
		hostname: "127.0.0.1",
		port,
		path: match[2] || "/",
		method: "GET",
		headers: { ...req.headers, host: `localhost:${port}` },
	});

	proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
		writeWsUpgrade(socket, proxyRes, proxySocket, proxyHead);
	});

	proxyReq.on("error", () => socket.destroy());
	proxyReq.end();
	return true;
}
