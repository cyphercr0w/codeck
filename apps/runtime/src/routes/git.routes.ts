import { Router } from "express";
import { cloneRepository, getGitDiff, listRepositories, WORKSPACE } from "../services/git.js";
import { sanitizeSecrets } from "../services/session-writer.js";
import { broadcastStatus } from "../web/websocket.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

// Git repositories in the workspace. Codeck's workspace root holds multiple
// projects as subdirectories (and is usually not a repo itself), so the SCM
// UI needs the concrete repo paths to run `git diff` against.
router.get("/repos", (_req, res) => {
	res.json({ repos: listRepositories() });
});

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
	// A diff can contain secrets (e.g. a modified .env) — sanitize before it hits the UI.
	res.json({ diff: sanitizeSecrets(result.diff) });
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
