/**
 * Browser Preview — CDP screencast for live site preview and agent browsing.
 *
 * Launches headless Chrome directly (no Playwright dependency), connects via
 * Chrome DevTools Protocol over WebSocket, and streams JPEG frames to clients.
 *
 * Flow: Chrome (real browser) → CDP screencast → JPEG frames → WS → <canvas>
 * No proxy, no iframe — Chrome navigates the real URL, so relative paths,
 * WebSocket HMR, cookies, localStorage all work exactly as in a real browser.
 */
import { spawn, type ChildProcess } from "child_process";
import { WebSocket } from "ws";
import { broadcast } from "../web/logger.js";

let chromeProc: ChildProcess | null = null;
let cdpWs: WebSocket | null = null;
let currentUrl = "";
let streaming = false;
let msgId = 1;
interface PendingEntry {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, PendingEntry>();

const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const CDP_PORT = 9333; // Dedicated port for preview (not the Playwright MCP one)

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

async function connectCDP(): Promise<void> {
	// Connect to the first PAGE target (not the browser-level debugger).
	// Page.navigate, Page.startScreencast, etc. only work on page targets.
	const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
	const targets = (await listRes.json()) as Array<{
		type: string;
		webSocketDebuggerUrl: string;
	}>;
	const pageTarget = targets.find((t) => t.type === "page");
	if (!pageTarget) throw new Error("No page target found in Chrome");
	const wsUrl = pageTarget.webSocketDebuggerUrl;

	return new Promise((resolve, reject) => {
		cdpWs = new WebSocket(wsUrl);
		cdpWs.on("open", () => resolve());
		cdpWs.on("error", (err) => reject(err));
		cdpWs.on("close", () => {
			cdpWs = null;
			streaming = false;
		});
		cdpWs.on("message", (raw: Buffer) => {
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

				// Screencast frame event
				if (msg.method === "Page.screencastFrame" && streaming) {
					const { data: frameData, sessionId, metadata } = msg.params;
					broadcast({
						type: "preview:frame",
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

// ── Chrome lifecycle ──

let ensureInProgress: Promise<void> | null = null;

async function ensureChrome(): Promise<void> {
	if (cdpWs && cdpWs.readyState === WebSocket.OPEN) return;
	if (ensureInProgress) return ensureInProgress;
	ensureInProgress = _ensureChrome().finally(() => {
		ensureInProgress = null;
	});
	return ensureInProgress;
}

async function _ensureChrome(): Promise<void> {
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
		// Kill zombie Chrome and throw
		if (chromeProc) {
			chromeProc.kill();
			chromeProc = null;
		}
		throw new Error("Chrome failed to start within 6 seconds");
	}

	await connectCDP();

	// Enable page events
	await cdpSend("Page.enable");
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
process.on("SIGTERM", () => closeBrowser());
process.on("SIGINT", () => closeBrowser());

// ── Public API ──

export async function startPreview(
	url: string,
): Promise<{ success: boolean; url: string; error?: string }> {
	try {
		await ensureChrome();
		currentUrl = url;

		// Navigate and check for errors (connection refused, DNS failure, etc.)
		const navResult = (await cdpSend("Page.navigate", { url })) as {
			frameId?: string;
			errorText?: string;
		};
		if (navResult?.errorText) {
			// Broadcast error state to frontend
			broadcast({
				type: "preview:error",
				error: navResult.errorText,
				url,
			});
			return {
				success: false,
				url,
				error: `Page not reachable: ${navResult.errorText}`,
			};
		}

		// Wait for initial paint
		await new Promise((r) => setTimeout(r, 500));

		if (!streaming) {
			await cdpSend("Page.startScreencast", {
				format: "jpeg",
				quality: 75,
				maxWidth: 1280,
				maxHeight: 720,
				everyNthFrame: 1,
			});
			streaming = true;
		}

		return { success: true, url: currentUrl };
	} catch (err) {
		return { success: false, url, error: (err as Error).message };
	}
}

export async function navigatePreview(
	url: string,
): Promise<{ success: boolean; url: string; error?: string }> {
	if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
		return startPreview(url);
	}

	try {
		currentUrl = url;
		const navResult = (await cdpSend("Page.navigate", { url })) as {
			errorText?: string;
		};
		if (navResult?.errorText) {
			broadcast({
				type: "preview:error",
				error: navResult.errorText,
				url,
			});
			return {
				success: false,
				url,
				error: `Page not reachable: ${navResult.errorText}`,
			};
		}
		return { success: true, url: currentUrl };
	} catch {
		return { success: false, url, error: "Navigation failed" };
	}
}

export async function stopPreview(): Promise<void> {
	streaming = false;
	try {
		await cdpSend("Page.stopScreencast");
	} catch {
		/* */
	}
}

export async function refreshPreview(): Promise<void> {
	try {
		await cdpSend("Page.reload");
	} catch {
		/* */
	}
}

export function getPreviewState(): {
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

// Input injection
export async function injectClick(x: number, y: number): Promise<void> {
	try {
		await cdpSend("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
		await cdpSend("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
	} catch {
		/* */
	}
}

export async function injectScroll(
	x: number,
	y: number,
	deltaX: number,
	deltaY: number,
): Promise<void> {
	try {
		await cdpSend("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x,
			y,
			deltaX,
			deltaY,
		});
	} catch {
		/* */
	}
}

export async function injectKeyPress(
	key: string,
	text?: string,
): Promise<void> {
	try {
		await cdpSend("Input.dispatchKeyEvent", {
			type: "keyDown",
			key,
			text: text || key,
		});
		await cdpSend("Input.dispatchKeyEvent", { type: "keyUp", key });
	} catch {
		/* */
	}
}

export async function takeScreenshot(): Promise<string | null> {
	try {
		const result = (await cdpSend("Page.captureScreenshot", {
			format: "jpeg",
			quality: 80,
		})) as { data: string };
		return result?.data || null;
	} catch {
		return null;
	}
}

export async function closeBrowser(): Promise<void> {
	streaming = false;
	currentUrl = "";
	// Close CDP WebSocket first (graceful)
	if (cdpWs) {
		try {
			// Tell Chrome to close the page before killing
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
	// Kill Chrome process tree
	if (chromeProc) {
		const pid = chromeProc.pid;
		chromeProc.kill("SIGKILL"); // SIGKILL to ensure all child processes die
		chromeProc = null;
		// Double-check: kill process group if still alive
		if (pid) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* not a process group leader — fine */
			}
		}
	}
	// Clear pending CDP promises
	drainPending("Browser closed");
}
