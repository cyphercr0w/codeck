import { Router } from "express";
import { cloneRepository, getGitDiff, WORKSPACE } from "../services/git.js";
import { broadcastStatus } from "../web/websocket.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

// Unified git diff for the interactive review loop.
// ?cwd=<dir> (default workspace) &staged=true|false &base=HEAD
router.get("/diff", (req, res) => {
	const cwd = (req.query.cwd as string) || WORKSPACE;
	const staged = req.query.staged === "true" || req.query.staged === "1";
	const base = typeof req.query.base === "string" ? req.query.base : undefined;
	const result = getGitDiff(cwd, { staged, base });
	if (result.error) {
		res.status(400).json({ error: result.error });
		return;
	}
	res.json({ diff: result.diff });
});

// Clone repository
router.post(
	"/clone",
	asyncHandler(async (req, res) => {
		const { url, token, useSSH } = req.body;
		if (!url || typeof url !== "string") {
			res.status(400).json({ error: "URL required (string)" });
			return;
		}
		if (url.length > 2048) {
			res.status(400).json({ error: "URL too long (max 2048 characters)" });
			return;
		}
		if (
			token !== undefined &&
			(typeof token !== "string" || token.length > 500)
		) {
			res.status(400).json({ error: "Invalid token format" });
			return;
		}

		const result = await cloneRepository(url, token, useSSH);
		broadcastStatus();
		res.json(result);
	}),
);

export default router;
