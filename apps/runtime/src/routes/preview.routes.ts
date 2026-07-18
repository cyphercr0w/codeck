/**
 * Browser Preview routes — start/stop/navigate the embedded Chrome preview,
 * handle input injection from the frontend canvas.
 */
import { Router } from "express";
import { broadcast } from "../web/logger.js";
import {
	startPreview,
	navigatePreview,
	stopPreview,
	refreshPreview,
	getPreviewState,
	injectClick,
	injectScroll,
	injectKeyPress,
	takeScreenshot,
} from "../services/browser-preview.js";
import {
	startPlaywrightScreencast,
	stopPlaywrightScreencast,
	getPlaywrightScreencastState,
	capturePlaywrightFrame,
	inspectElementAt,
} from "../services/playwright-screencast.js";
import { DENIED_PORTS } from "./preview-proxy.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

function isLocalhostUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		// Must be http or https
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return false;
		// Hostname must be strictly localhost/127.0.0.1/0.0.0.0 (no @-based bypass)
		const host = parsed.hostname;
		if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0")
			return false;
		// Reject internal service ports
		const port = parseInt(parsed.port || "80", 10);
		if (DENIED_PORTS.has(port)) return false;
		// No userinfo allowed (@ bypass)
		if (parsed.username || parsed.password) return false;
		return true;
	} catch {
		return false;
	}
}

// Start preview — launch Chrome and navigate to URL
router.post(
	"/start",
	asyncHandler(async (req, res) => {
		const { url } = req.body || {};
		if (!url || typeof url !== "string") {
			res.status(400).json({ error: "URL required" });
			return;
		}
		if (!isLocalhostUrl(url)) {
			res
				.status(400)
				.json({ error: "Only localhost URLs allowed for security" });
			return;
		}
		const result = await startPreview(url);
		res.json(result);
	}),
);

// Navigate to a new URL
router.post(
	"/navigate",
	asyncHandler(async (req, res) => {
		const { url } = req.body || {};
		if (!url || typeof url !== "string") {
			res.status(400).json({ error: "URL required" });
			return;
		}
		if (!isLocalhostUrl(url)) {
			res
				.status(400)
				.json({ error: "Only localhost URLs allowed for security" });
			return;
		}
		const result = await navigatePreview(url);
		res.json(result);
	}),
);

// Stop screencast
router.post(
	"/stop",
	asyncHandler(async (_req, res) => {
		await stopPreview();
		res.json({ success: true });
	}),
);

// Refresh page
router.post(
	"/refresh",
	asyncHandler(async (_req, res) => {
		await refreshPreview();
		res.json({ success: true });
	}),
);

// Get current state
router.get("/status", (_req, res) => {
	res.json(getPreviewState());
});

// Input injection — validate coordinates are finite numbers within screen bounds
function clampCoord(v: unknown, max: number): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(n, max));
}

router.post(
	"/input/click",
	asyncHandler(async (req, res) => {
		const { x, y } = req.body || {};
		if (
			typeof x !== "number" ||
			typeof y !== "number" ||
			!Number.isFinite(x) ||
			!Number.isFinite(y)
		) {
			res.status(400).json({ error: "x and y must be finite numbers" });
			return;
		}
		await injectClick(clampCoord(x, 1920), clampCoord(y, 1080));
		res.json({ success: true });
	}),
);

router.post(
	"/input/scroll",
	asyncHandler(async (req, res) => {
		const { x, y, deltaX, deltaY } = req.body || {};
		await injectScroll(
			clampCoord(x, 1920),
			clampCoord(y, 1080),
			clampCoord(deltaX, 10000),
			clampCoord(deltaY, 10000),
		);
		res.json({ success: true });
	}),
);

router.post(
	"/input/key",
	asyncHandler(async (req, res) => {
		const { key, text } = req.body || {};
		if (typeof key !== "string" || key.length === 0 || key.length > 64) {
			res
				.status(400)
				.json({ error: "key must be a non-empty string (max 64 chars)" });
			return;
		}
		if (text !== undefined && (typeof text !== "string" || text.length > 256)) {
			res.status(400).json({ error: "text must be a string (max 256 chars)" });
			return;
		}
		await injectKeyPress(key, text);
		res.json({ success: true });
	}),
);

// ── Agent-controlled preview ─────────────────────────────────────────

// Agent opens a preview for the user (broadcast via WebSocket)
router.post("/navigate-to", (req, res) => {
	const { port, url } = req.body || {};
	if (
		typeof port !== "number" ||
		!Number.isFinite(port) ||
		port < 1 ||
		port > 65535
	) {
		res.status(400).json({ error: "port must be a valid number" });
		return;
	}
	// Broadcast to all connected clients — frontend will open the preview
	broadcast({
		type: "preview:navigate",
		data: { port, url: url || `localhost:${port}` },
	});
	res.json({ success: true });
});

// ── Playwright browser screencast ──────────────────────────────────
router.get("/playwright/status", (_req, res) => {
	res.json(getPlaywrightScreencastState());
});

router.post(
	"/playwright/start",
	asyncHandler(async (_req, res) => {
		await startPlaywrightScreencast();
		res.json({ success: true });
	}),
);

router.post(
	"/playwright/stop",
	asyncHandler(async (_req, res) => {
		await stopPlaywrightScreencast();
		res.json({ success: true });
	}),
);

// Fresh screenshot from current page target (immune to stale CDP connections)
router.get(
	"/playwright/frame",
	asyncHandler(async (_req, res) => {
		const frame = await capturePlaywrightFrame();
		res.json({ data: frame });
	}),
);

// Design Mode — resolve a click to the DOM element there (selector + outerHTML)
router.post(
	"/playwright/inspect",
	asyncHandler(async (req, res) => {
		const { x, y } = req.body || {};
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
			res.status(400).json({ error: "x and y must be finite numbers" });
			return;
		}
		const el = await inspectElementAt(clampCoord(x, 4096), clampCoord(y, 4096));
		if (!el) { res.status(404).json({ error: "No element at that location" }); return; }
		res.json(el);
	}),
);

// Screenshot (for agent use)
router.get(
	"/screenshot",
	asyncHandler(async (_req, res) => {
		const data = await takeScreenshot();
		if (data) {
			res.json({ success: true, data });
		} else {
			res.json({ success: false, error: "No active preview" });
		}
	}),
);

export default router;
