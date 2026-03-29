import { Router } from "express";
import { request as httpRequest } from "http";
import {
	getNetworkInfo,
	isPortExposed,
	getMappedPorts,
	getCodeckPort,
	addMappedPort,
	removeMappedPort,
	writePortOverride,
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

// GET /api/system/network-info — returns network mode, mapped ports, container ID
router.get("/network-info", (_req, res) => {
	res.json(getNetworkInfo());
});

// POST /api/system/add-port — expose a port to the host
router.post(
	"/add-port",
	asyncHandler(async (req, res) => {
		const { port } = req.body;
		if (!port || typeof port !== "number" || port < 1 || port > 65535) {
			res.status(400).json({ error: "Invalid port number (1-65535)" });
			return;
		}

		// Managed mode: delegate to daemon
		if (DAEMON_URL) {
			try {
				const result = await delegateToDaemon("POST", "/api/system/add-port", {
					port,
				});
				res.status(result.status).json(result.data);
			} catch (e) {
				console.error(
					"[System] Daemon delegation failed:",
					(e as Error).message,
				);
				res.status(502).json({
					success: false,
					error: "Could not reach daemon for port management",
				});
			}
			return;
		}

		// Isolated mode: existing Docker CLI path (requires Docker socket)
		if (isPortExposed(port)) {
			res.json({ success: true, alreadyMapped: true });
			return;
		}

		if (!canAutoRestart()) {
			res.json({
				success: false,
				requiresRestart: true,
				instructions: `Port ${port} is not mapped. Add "${port}:${port}" to docker/compose.override.yml and restart the container.`,
			});
			return;
		}

		try {
			const allPorts = [...getMappedPorts(), port];
			writePortOverride(allPorts);
			addMappedPort(port);
			saveSessionState(
				"port-add",
				`Port ${port} has been exposed. Continue your previous task.`,
			);
			res.json({ success: true, restarting: true });
			setTimeout(() => {
				try {
					spawnComposeRestart();
				} catch (e) {
					removeMappedPort(port);
					console.error(
						"[System] Failed to spawn restart, rolled back port add:",
						(e as Error).message,
					);
				}
			}, 500);
		} catch (e) {
			console.error("[System] Auto-restart failed:", (e as Error).message);
			res.json({
				success: false,
				requiresRestart: true,
				instructions: `Auto-restart failed. Manually add "${port}:${port}" to docker/compose.override.yml and restart.`,
			});
		}
	}),
);

// POST /api/system/remove-port — remove a port mapping
router.post(
	"/remove-port",
	asyncHandler(async (req, res) => {
		const { port } = req.body;
		if (!port || typeof port !== "number" || port < 1 || port > 65535) {
			res.status(400).json({ error: "Invalid port number (1-65535)" });
			return;
		}

		// Managed mode: delegate to daemon
		if (DAEMON_URL) {
			try {
				const result = await delegateToDaemon(
					"POST",
					"/api/system/remove-port",
					{
						port,
					},
				);
				res.status(result.status).json(result.data);
			} catch (e) {
				console.error(
					"[System] Daemon delegation failed:",
					(e as Error).message,
				);
				res.status(502).json({
					success: false,
					error: "Could not reach daemon for port management",
				});
			}
			return;
		}

		// Isolated mode: existing Docker CLI path
		if (port === getCodeckPort()) {
			res.status(400).json({ error: "Cannot remove the Codeck port" });
			return;
		}

		if (!isPortExposed(port)) {
			res.json({ success: true, notMapped: true });
			return;
		}

		if (!canAutoRestart()) {
			res.json({
				success: false,
				requiresRestart: true,
				instructions: `Remove the "${port}:${port}" line from docker/compose.override.yml and restart the container.`,
			});
			return;
		}

		try {
			removeMappedPort(port);
			const remainingPorts = getMappedPorts();
			writePortOverride(remainingPorts);
			saveSessionState(
				"port-remove",
				`Port ${port} has been unmapped. Continue your previous task.`,
			);
			res.json({ success: true, restarting: true, remainingPorts });
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
		} catch (e) {
			console.error("[System] Port removal failed:", (e as Error).message);
			addMappedPort(port);
			res.json({
				success: false,
				requiresRestart: true,
				instructions: `Auto-restart failed. Manually edit docker/compose.override.yml and restart.`,
			});
		}
	}),
);

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
				res
					.status(502)
					.json({
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

export default router;
