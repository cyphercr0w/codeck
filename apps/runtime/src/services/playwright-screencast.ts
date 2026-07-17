/**
 * Playwright Screencast — CDP screencast for monitoring the Playwright MCP browser.
 *
 * Launches a second headless Chrome instance on port 9222, shared with Playwright MCP
 * via --cdp-endpoint. Streams JPEG frames to clients and auto-detects navigation events
 * triggered by Playwright MCP.
 *
 * Flow: Chrome (port 9222) → CDP screencast → JPEG frames → WS → <canvas>
 */
import { spawn, type ChildProcess } from "child_process";
import { WebSocket } from "ws";
import { broadcast } from "../web/logger.js";

let chromeProc: ChildProcess | null = null;
let cdpWs: WebSocket | null = null;
let currentUrl = "";
let streaming = false;
let msgId = 1;
let lastFrame: string | null = null; // Cache last JPEG base64 frame for late-joining clients
let connectedTargetWsUrl: string | null = null;
let targetPollInterval: ReturnType<typeof setInterval> | null = null;
interface PendingEntry {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, PendingEntry>();

const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const CDP_PORT = 9222; // Shared with Playwright MCP

/** Reject all pending CDP promises (used on Chrome crash / close) */
function drainPending(reason: string): void {
	for (const [, entry] of pending) {
		clearTimeout(entry.timer);
		entry.reject(new Error(reason));
	}
	pending.clear();
}

// ── CDP helpers ──

function cdpSend(
	method: string,
	params: Record<string, unknown> = {},
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
			return reject(new Error("CDP not connected"));
		}
		const id = msgId++;
		const timer = setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}
		}, 10000);
		pending.set(id, { resolve, reject, timer });
		cdpWs.send(JSON.stringify({ id, method, params }));
	});
}

function connectToWsUrl(wsUrl: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		cdpWs = ws;
		ws.on("open", () => resolve());
		ws.on("error", (err) => reject(err));
		ws.on("close", () => {
			if (cdpWs === ws) {
				cdpWs = null;
				streaming = false;
				connectedTargetWsUrl = null;
			}
		});
		ws.on("message", (raw: Buffer) => {
			try {
				const msg = JSON.parse(raw.toString());

				// Response to a command
				if (msg.id && pending.has(msg.id)) {
					const entry = pending.get(msg.id)!;
					pending.delete(msg.id);
					clearTimeout(entry.timer);
					entry.resolve(msg.result);
					return;
				}

				// Auto-detect Playwright MCP navigation (main frame only)
				if (msg.method === "Page.frameNavigated") {
					// Skip iframe navigations — only react to main frame
					if (msg.params?.frame?.parentId) return;
					const url: string = msg.params?.frame?.url || "";
					if (url && url !== "about:blank") {
						currentUrl = url;
						broadcast({ type: "playwright:navigate", url });
						// Auto-start screencast when Playwright navigates to a real page
						if (!streaming) {
							cdpSend("Page.startScreencast", {
								format: "jpeg",
								quality: 60,
								maxWidth: 1280,
								maxHeight: 720,
								everyNthFrame: 2,
							})
								.then(() => {
									streaming = true;
								})
								.catch(() => {});
						}
					} else if (url === "about:blank" && streaming) {
						// Playwright navigated back to blank — stop screencast
						streaming = false;
						currentUrl = "";
						cdpSend("Page.stopScreencast").catch(() => {});
						broadcast({ type: "playwright:stopped" });
					}
					return;
				}

				// Screencast frame event
				if (msg.method === "Page.screencastFrame" && streaming) {
					const { data: frameData, sessionId, metadata } = msg.params;
					lastFrame = frameData;
					broadcast({
						type: "playwright:frame",
						data: frameData,
						metadata,
					});
					// Ack immediately so Chrome sends next frame
					cdpSend("Page.screencastFrameAck", { sessionId }).catch(() => {});
				}
			} catch {
				/* malformed message */
			}
		});
	});
}

async function connectCDP(): Promise<void> {
	const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
	const targets = (await listRes.json()) as Array<{
		type: string;
		webSocketDebuggerUrl: string;
	}>;
	const pageTarget = targets.find((t) => t.type === "page");
	if (!pageTarget) throw new Error("No page target found in Chrome");
	const wsUrl = pageTarget.webSocketDebuggerUrl;
	connectedTargetWsUrl = wsUrl;
	await connectToWsUrl(wsUrl);
}

let reconnecting = false;

function startTargetPolling(): void {
	if (targetPollInterval) return;
	targetPollInterval = setInterval(async () => {
		if (reconnecting) return;
		try {
			const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
			const targets = (await listRes.json()) as Array<{
				type: string;
				url: string;
				webSocketDebuggerUrl: string;
			}>;
			const activeTarget = targets.find(
				(t) => t.type === "page" && t.url !== "about:blank",
			);
			if (
				activeTarget &&
				activeTarget.webSocketDebuggerUrl !== connectedTargetWsUrl
			) {
				reconnecting = true;
				try {
					// Close existing connection
					if (cdpWs) {
						streaming = false;
						try {
							cdpWs.close();
						} catch {
							/* */
						}
						cdpWs = null;
					}
					drainPending("Reconnecting to new target");

					// Connect to new target
					connectedTargetWsUrl = activeTarget.webSocketDebuggerUrl;
					await connectToWsUrl(activeTarget.webSocketDebuggerUrl);
					await cdpSend("Page.enable");

					// Broadcast navigation and start screencast
					currentUrl = activeTarget.url;
					broadcast({ type: "playwright:navigate", url: currentUrl });
					await cdpSend("Page.startScreencast", {
						format: "jpeg",
						quality: 60,
						maxWidth: 1280,
						maxHeight: 720,
						everyNthFrame: 2,
					});
					streaming = true;
				} finally {
					reconnecting = false;
				}
			}
		} catch {
			/* Chrome not ready or transient failure */
		}
	}, 1500);
}

function stopTargetPolling(): void {
	if (targetPollInterval) {
		clearInterval(targetPollInterval);
		targetPollInterval = null;
	}
}

// ── Chrome lifecycle ──

let ensureInProgress: Promise<void> | null = null;

async function _ensurePlaywrightChrome(): Promise<void> {
	// Kill any existing Chrome instance on our port
	if (chromeProc) {
		chromeProc.kill();
		chromeProc = null;
	}

	chromeProc = spawn(
		CHROME_PATH,
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--disable-software-rasterizer",
			`--remote-debugging-port=${CDP_PORT}`,
			"--window-size=1280,720",
			"about:blank",
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	chromeProc.on("exit", () => {
		stopTargetPolling();
		chromeProc = null;
		cdpWs = null;
		streaming = false;
		drainPending("Chrome exited");
	});

	// Wait for Chrome to be ready (polls /json/version)
	let chromeReady = false;
	for (let i = 0; i < 30; i++) {
		try {
			await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
			chromeReady = true;
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	if (!chromeReady) {
		if (chromeProc) {
			chromeProc.kill();
			chromeProc = null;
		}
		throw new Error("Chrome failed to start within 6 seconds");
	}

	await connectCDP();

	// Enable page and network events for auto-detection
	await cdpSend("Page.enable");
	await cdpSend("Network.enable");
	startTargetPolling();
}

// Cleanup on process exit — prevent orphaned Chrome
process.on("exit", () => {
	if (chromeProc) {
		try {
			chromeProc.kill();
		} catch {
			/* */
		}
	}
});
process.on("SIGTERM", () => closePlaywrightBrowser());
process.on("SIGINT", () => closePlaywrightBrowser());

// ── Public API ──

export async function ensurePlaywrightChrome(): Promise<void> {
	if (cdpWs && cdpWs.readyState === WebSocket.OPEN) return;
	if (ensureInProgress) return ensureInProgress;
	ensureInProgress = _ensurePlaywrightChrome().finally(() => {
		ensureInProgress = null;
	});
	return ensureInProgress;
}

export async function startPlaywrightScreencast(): Promise<void> {
	await ensurePlaywrightChrome();
	if (streaming) return;
	await cdpSend("Page.startScreencast", {
		format: "jpeg",
		quality: 60,
		maxWidth: 1280,
		maxHeight: 720,
		everyNthFrame: 2,
	});
	streaming = true;
}

export async function stopPlaywrightScreencast(): Promise<void> {
	streaming = false;
	lastFrame = null;
	try {
		await cdpSend("Page.stopScreencast");
	} catch {
		/* */
	}
}

export function getPlaywrightScreencastState(): {
	active: boolean;
	url: string;
	streaming: boolean;
} {
	return {
		active: !!cdpWs && cdpWs.readyState === WebSocket.OPEN,
		url: currentUrl,
		streaming,
	};
}

/**
 * Take a fresh screenshot from the current CDP page target.
 * Connects to the latest page target each time — immune to stale connections
 * caused by Playwright MCP creating new contexts/pages.
 */
export async function capturePlaywrightFrame(): Promise<string | null> {
	try {
		const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
		const targets = (await listRes.json()) as Array<{
			type: string;
			url: string;
			webSocketDebuggerUrl: string;
		}>;
		const pageTarget = targets.find(
			(t) => t.type === "page" && t.url !== "about:blank",
		);
		if (!pageTarget) return lastFrame;

		// Update URL if it changed (Playwright navigated in a new context)
		if (pageTarget.url !== currentUrl) {
			currentUrl = pageTarget.url;
			broadcast({ type: "playwright:navigate", url: currentUrl });
		}

		const wsUrl = pageTarget.webSocketDebuggerUrl;
		const frame = await new Promise<string | null>((resolve) => {
			const ws = new WebSocket(wsUrl);
			let id = 1;
			const timeout = setTimeout(() => {
				ws.close();
				resolve(lastFrame);
			}, 5000);

			ws.on("open", () => {
				ws.send(
					JSON.stringify({
						id: id++,
						method: "Page.captureScreenshot",
						params: { format: "jpeg", quality: 70 },
					}),
				);
			});
			ws.on("message", (raw: Buffer) => {
				try {
					const msg = JSON.parse(raw.toString());
					if (msg.result?.data) {
						clearTimeout(timeout);
						lastFrame = msg.result.data;
						ws.close();
						resolve(msg.result.data);
					}
				} catch {
					/* */
				}
			});
			ws.on("error", () => {
				clearTimeout(timeout);
				resolve(lastFrame);
			});
		});
		return frame;
	} catch {
		return lastFrame;
	}
}

/**
 * Design Mode — resolve a viewport coordinate to the DOM element there, via CDP
 * DOM.getNodeForLocation. Returns a rough CSS selector + a truncated outerHTML
 * snippet so the agent can locate and edit the element. Coordinates are in
 * page/frame pixels (the client maps its click into the frame's natural size).
 */
export async function inspectElementAt(
	x: number,
	y: number,
): Promise<{ tag: string; selector: string; outerHTML: string; url: string } | null> {
	try {
		if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) await ensurePlaywrightChrome();
		await cdpSend("DOM.enable").catch(() => {});
		const loc = (await cdpSend("DOM.getNodeForLocation", {
			x: Math.max(0, Math.round(x)),
			y: Math.max(0, Math.round(y)),
			includeUserAgentShadowDOM: false,
		})) as { backendNodeId?: number } | null;
		const backendNodeId = loc?.backendNodeId;
		if (!backendNodeId) return null;

		let outerHTML = "";
		try {
			const oh = (await cdpSend("DOM.getOuterHTML", { backendNodeId })) as { outerHTML?: string };
			// Single-line + truncated: this ends up in a PTY reprompt.
			outerHTML = (oh?.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 400);
		} catch { /* optional */ }

		let tag = "";
		let selector = "";
		try {
			const desc = (await cdpSend("DOM.describeNode", { backendNodeId })) as { node?: { localName?: string; nodeName?: string; attributes?: string[] } };
			const node = desc?.node;
			tag = (node?.localName || node?.nodeName || "").toLowerCase();
			const attrs = node?.attributes || [];
			let id = "";
			let cls = "";
			for (let i = 0; i < attrs.length; i += 2) {
				if (attrs[i] === "id") id = attrs[i + 1];
				if (attrs[i] === "class") cls = attrs[i + 1];
			}
			selector =
				tag +
				(id ? `#${id}` : "") +
				(cls ? `.${cls.trim().split(/\s+/).filter(Boolean).join(".")}` : "");
		} catch { /* optional */ }

		// Strip whitespace/newlines: an element id/class from an attacker-influenced
		// page must not inject a newline into the single-line agent reprompt.
		selector = (selector || tag).replace(/\s+/g, "");
		return { tag, selector, outerHTML, url: currentUrl.replace(/[\r\n]+/g, " ") };
	} catch {
		return null;
	}
}

export async function closePlaywrightBrowser(): Promise<void> {
	stopTargetPolling();
	streaming = false;
	currentUrl = "";
	lastFrame = null;
	if (cdpWs) {
		try {
			await cdpSend("Browser.close").catch(() => {});
		} catch {
			/* */
		}
		try {
			cdpWs.close();
		} catch {
			/* */
		}
		cdpWs = null;
	}
	if (chromeProc) {
		const pid = chromeProc.pid;
		chromeProc.kill("SIGKILL");
		chromeProc = null;
		if (pid) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* not a process group leader — fine */
			}
		}
	}
	drainPending("Browser closed");
}
