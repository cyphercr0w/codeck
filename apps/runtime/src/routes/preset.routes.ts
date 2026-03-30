import { Router } from "express";
import {
	listPresets,
	getPresetStatus,
	applyPreset,
	isValidPresetId,
	setAutoUpdate,
	getPresetContents,
	writeOverrides,
	applyOverrides,
	type PresetOverrides,
} from "../services/preset.js";
import { broadcastStatus } from "../web/websocket.js";
import { updateClaudeMd } from "../services/git.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

// List all available presets (reads manifests dynamically)
router.get("/", (_req, res) => {
	res.json(listPresets());
});

// Get preset configuration status
router.get("/status", (_req, res) => {
	res.json(getPresetStatus());
});

// Apply a preset by ID
router.post(
	"/apply",
	asyncHandler(async (req, res) => {
		const { presetId } = req.body;
		if (!presetId || typeof presetId !== "string") {
			res.status(400).json({ error: "presetId is required" });
			return;
		}
		if (!isValidPresetId(presetId)) {
			res.status(400).json({
				error:
					"Invalid presetId. Must be alphanumeric with hyphens/underscores.",
			});
			return;
		}

		try {
			await applyPreset(presetId);
			// Refresh /workspace/CLAUDE.md with project list (Layer 2)
			updateClaudeMd();
			broadcastStatus();
			res.json({ success: true, presetId });
		} catch (err) {
			console.error("[Preset] Error applying preset:", (err as Error).message);
			res.status(500).json({
				error: "Failed to apply preset. Check server logs for details.",
			});
		}
	}),
);

// Update preset: re-apply current preset without force.
// Overwrites scripts/hooks/configs but preserves user data (memory, preferences, rules).
router.post(
	"/update",
	asyncHandler(async (_req, res) => {
		const status = getPresetStatus();
		if (!status.configured || !status.presetId) {
			res.status(400).json({ error: "No preset configured" });
			return;
		}

		try {
			await applyPreset(status.presetId); // no force = preserves data files
			updateClaudeMd();
			broadcastStatus();
			res.json({
				success: true,
				presetId: status.presetId,
				message:
					"Preset updated. Scripts and hooks refreshed, user data preserved.",
			});
		} catch (err) {
			console.error("[Preset] Error updating preset:", (err as Error).message);
			res.status(500).json({
				error: "Failed to update preset. Check server logs for details.",
			});
		}
	}),
);

// Reset current preset to defaults (force re-apply, overwrites all files including user data)
router.post(
	"/reset",
	asyncHandler(async (_req, res) => {
		const status = getPresetStatus();
		if (!status.configured || !status.presetId) {
			res.status(400).json({ error: "No preset configured" });
			return;
		}

		try {
			await applyPreset(status.presetId, true);
			updateClaudeMd();
			broadcastStatus();
			res.json({ success: true, presetId: status.presetId });
		} catch (err) {
			console.error("[Preset] Error resetting preset:", (err as Error).message);
			res.status(500).json({
				error: "Failed to reset preset. Check server logs for details.",
			});
		}
	}),
);

// Get all preset items (hooks, skills, agents, MCPs) with enabled/disabled state
router.get("/contents", (req, res) => {
	try {
		const presetId = (req.query.presetId as string) || "default";
		const contents = getPresetContents(presetId);
		res.json(contents);
	} catch (err) {
		console.error("[Preset] Error getting contents:", (err as Error).message);
		res.status(500).json({ error: "Failed to load preset contents" });
	}
});

// Save user's preset override decisions and apply them
router.post("/overrides", async (req, res) => {
	try {
		const overrides = req.body as PresetOverrides;

		// Validate structure
		if (!overrides || typeof overrides !== "object") {
			res.status(400).json({ error: "Invalid overrides format" });
			return;
		}

		// Normalize: ensure all fields exist with arrays
		const normalized: PresetOverrides = {
			hooks: {
				disabled: Array.isArray(overrides.hooks?.disabled)
					? overrides.hooks.disabled
					: [],
			},
			skills: {
				disabled: Array.isArray(overrides.skills?.disabled)
					? overrides.skills.disabled
					: [],
			},
			agents: {
				disabled: Array.isArray(overrides.agents?.disabled)
					? overrides.agents.disabled
					: [],
			},
			mcpServers: {
				disabled: Array.isArray(overrides.mcpServers?.disabled)
					? overrides.mcpServers.disabled
					: [],
			},
		};

		writeOverrides(normalized);
		applyOverrides(normalized);

		res.json({ success: true });
	} catch (err) {
		console.error("[Preset] Error saving overrides:", (err as Error).message);
		res.status(500).json({ error: "Failed to save overrides" });
	}
});

// Toggle auto-update on/off
router.post("/auto-update", (req, res) => {
	const { enabled } = req.body || {};
	if (typeof enabled !== "boolean") {
		res.status(400).json({ error: "enabled (boolean) is required" });
		return;
	}
	setAutoUpdate(enabled);
	res.json({ success: true, autoUpdate: enabled });
});

export default router;
