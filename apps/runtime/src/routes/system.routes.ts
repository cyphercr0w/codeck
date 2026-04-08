import { Router } from "express";
import { request as httpRequest } from "http";
import {
	spawnComposeRestart,
	canAutoRestart,
} from "../services/port-manager.js";
import { saveSessionState, updateAgentBinary } from "../services/console.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

const DAEMON_URL = process.env.CODECK_DAEMON_URL || "";

/**
 * Delegate a request to the daemon's port management API.
 * Used in managed mode where the daemon (on the host) handles port exposure.
 */
function delegateToDaemon(
	method: string,
	path: string,
	body: Record<string, unknown> | null,
): Promise<{ status: number; data: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const url = new URL(path, DAEMON_URL);
		const bodyStr = body ? JSON.stringify(body) : null;
		const req = httpRequest(
			url.href,
			{
				method,
				headers: bodyStr
					? {
							"content-type": "application/json",
							"content-length": String(Buffer.byteLength(bodyStr)),
						}
					: {},
				timeout: 30_000,
			},
			(res) => {
				let data = "";
				res.on("data", (chunk: Buffer) => {
					data += chunk;
				});
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode || 500, data: JSON.parse(data) });
					} catch {
						resolve({
							status: res.statusCode || 500,
							data: { error: "Invalid response from daemon" },
						});
					}
				});
			},
		);
		req.on("error", (err) => reject(err));
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("Daemon timeout"));
		});
		if (bodyStr) req.write(bodyStr);
		req.end();
	});
}

// POST /api/system/restart — restart the runtime container via the daemon.
// In managed mode the runtime is isolated: host-level restarts must go through
// the daemon (which owns Docker lifecycle). This preserves the security boundary
// where the runtime cannot execute arbitrary host commands.
router.post(
	"/restart",
	asyncHandler(async (req, res) => {
		if (DAEMON_URL) {
			// Managed mode: save sessions so they restore after restart, then delegate.
			saveSessionState(
				"restart",
				"Container restarting. Sessions will be restored automatically.",
			);
			try {
				const result = await delegateToDaemon(
					"POST",
					"/api/system/restart",
					null,
				);
				res.status(result.status).json(result.data);
			} catch (e) {
				console.error(
					"[System] Daemon restart delegation failed:",
					(e as Error).message,
				);
				res.status(502).json({
					success: false,
					error: "Could not reach daemon for restart",
				});
			}
			return;
		}

		// Isolated mode: use compose restart if Docker socket is available.
		if (!canAutoRestart()) {
			res.status(501).json({
				success: false,
				error: "Restart requires managed mode or a Docker socket",
			});
			return;
		}
		saveSessionState(
			"restart",
			"Container restarting. Sessions will be restored automatically.",
		);
		res.json({ success: true, restarting: true });
		setTimeout(() => {
			try {
				spawnComposeRestart();
			} catch (e) {
				console.error(
					"[System] Failed to spawn restart:",
					(e as Error).message,
				);
			}
		}, 500);
	}),
);

// POST /api/system/update-agent — safely update the agent CLI binary
router.post(
	"/update-agent",
	asyncHandler(async (_req, res) => {
		try {
			const result = await updateAgentBinary();
			res.json({ success: true, ...result });
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			console.log(`[System] Agent CLI update failed: ${detail}`);
			res.status(500).json({ success: false, error: "Agent update failed" });
		}
	}),
);

// ── Model switching ──

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { ACTIVE_AGENT } from "../services/agent.js";

const VALID_MODELS: Record<string, string> = {
	sonnet: "sonnet",
	opus: "opus",
	"opus[1m]": "opus[1m]",
	haiku: "haiku",
};

router.get("/model", (_req, res) => {
	try {
		const settings = JSON.parse(
			readFileSync(ACTIVE_AGENT.settingsFile, "utf-8"),
		);
		res.json({ model: settings.model || "sonnet" });
	} catch {
		res.json({ model: "sonnet" });
	}
});

router.post("/model", (req, res) => {
	const { model } = req.body;
	if (!model || !VALID_MODELS[model]) {
		res
			.status(400)
			.json({ error: "Invalid model. Use: sonnet, opus, opus[1m], haiku" });
		return;
	}
	try {
		let settings: Record<string, unknown> = {};
		if (existsSync(ACTIVE_AGENT.settingsFile)) {
			settings = JSON.parse(readFileSync(ACTIVE_AGENT.settingsFile, "utf-8"));
		}
		settings.model = VALID_MODELS[model];
		writeFileSync(
			ACTIVE_AGENT.settingsFile,
			JSON.stringify(settings, null, "\t"),
		);
		res.json({ success: true, model: settings.model });
	} catch (e) {
		res.status(500).json({ error: (e as Error).message });
	}
});

// GET /api/system/ui-settings — returns persisted UI settings (theme, font, sidebar)
router.get("/ui-settings", (_req, res) => {
	try {
		const configPath = join(
			process.env.WORKSPACE || "/workspace",
			".codeck",
			"config.json",
		);
		let config: Record<string, unknown> = {};
		if (existsSync(configPath)) {
			config = JSON.parse(readFileSync(configPath, "utf-8"));
		}
		res.json((config as Record<string, unknown>).uiSettings || {});
	} catch {
		res.json({});
	}
});

// POST /api/system/ui-settings — save UI settings
router.post("/ui-settings", (req, res) => {
	try {
		const configPath = join(
			process.env.WORKSPACE || "/workspace",
			".codeck",
			"config.json",
		);
		let config: Record<string, unknown> = {};
		if (existsSync(configPath)) {
			config = JSON.parse(readFileSync(configPath, "utf-8"));
		}
		config.uiSettings = {
			...((config.uiSettings as Record<string, unknown>) || {}),
			...req.body,
		};
		writeFileSync(configPath, JSON.stringify(config, null, 2));
		res.json({
			success: true,
			...(config.uiSettings as Record<string, unknown>),
		});
	} catch {
		res.status(500).json({ error: "Failed to save settings" });
	}
});

// GET /api/system/token-settings — returns current token optimization settings
router.get("/token-settings", (req, res) => {
	try {
		const configPath = join(
			process.env.WORKSPACE || "/workspace",
			".codeck",
			"config.json",
		);
		let config: any = {};
		if (existsSync(configPath)) {
			config = JSON.parse(readFileSync(configPath, "utf-8"));
		}
		const defaults = {
			compactionPct: 50,
			effortLevel: "medium",
			mcpDeferThreshold: 5,
			thinkingTokens: 10000,
		};
		res.json({ ...defaults, ...config.tokenSettings });
	} catch (err) {
		res.status(500).json({ error: "Failed to read settings" });
	}
});

// POST /api/system/token-settings — save token optimization settings
router.post("/token-settings", (req, res) => {
	try {
		const configPath = join(
			process.env.WORKSPACE || "/workspace",
			".codeck",
			"config.json",
		);
		let config: any = {};
		if (existsSync(configPath)) {
			config = JSON.parse(readFileSync(configPath, "utf-8"));
		}
		const body = req.body;
		config.tokenSettings = {
			compactionPct: Math.max(
				10,
				Math.min(90, Number(body.compactionPct) || 50),
			),
			effortLevel: ["low", "medium", "high", "max"].includes(body.effortLevel)
				? body.effortLevel
				: "medium",
			mcpDeferThreshold: Math.max(
				1,
				Math.min(20, Number(body.mcpDeferThreshold) || 5),
			),
			thinkingTokens: Math.max(
				1000,
				Math.min(50000, Number(body.thinkingTokens) || 10000),
			),
		};
		writeFileSync(configPath, JSON.stringify(config, null, 2));
		res.json({ success: true, ...config.tokenSettings });
	} catch (err) {
		res.status(500).json({ error: "Failed to save settings" });
	}
});

export default router;
