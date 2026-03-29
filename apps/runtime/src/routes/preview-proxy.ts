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
import http, { IncomingMessage } from "http";
import type { Socket } from "net";
import { getActivePorts } from "../services/ports.js";

const router = Router();

const BLOCKED_HEADERS = new Set([
	"x-frame-options",
	"content-security-policy",
	"content-security-policy-report-only",
]);

// Shared deny list — single source of truth. Covers internal services,
// debug ports, databases, and container infrastructure.
export const DENIED_PORTS = new Set([
	80, // Codeck itself
	443, // HTTPS
	2375,
	2376, // Docker daemon
	3306, // MySQL
	5432, // PostgreSQL
	6379, // Redis
	8080, // Common internal admin
	9222, // Chrome DevTools Protocol
	9229, // Node.js inspector
	9333, // Codeck internal
	27017, // MongoDB
	35989, // Codeck internal
]);

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

// ── Subdomain middleware (for Cloudflare / wildcard DNS) ────────────

/**
 * Extract preview port from Host header.
 * Matches: preview-4321.localhost, preview-4321.dev.codeck.xyz, etc.
 * Limits to 1-5 digits to prevent unbounded parsing.
 */
function extractSubdomainPort(host: string | undefined): number | null {
	if (!host) return null;
	const hostname = host.split(":")[0];
	// Match all formats:
	// - 5173.localhost (shortest — just the port number)
	// - p4321.codeck.xyz (single-level, covered by free Cloudflare SSL)
	// - preview-4321.localhost (development, legacy)
	const match = hostname.match(/^(?:p|preview-)?(\d{1,5})\./);
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

	// Path-based proxy: HEAD for reachability checks (any valid port),
	// other methods require the port to be actively listening
	if (req.method !== "HEAD") {
		const activePorts = getActivePorts();
		if (!activePorts.some((p: { port: number }) => p.port === port)) {
			res.status(404).json({ error: "No service on this port" });
			return;
		}
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
	const activePorts = getActivePorts();
	if (
		!validatePort(port) ||
		!activePorts.some((p: { port: number }) => p.port === port)
	) {
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
