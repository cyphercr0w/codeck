/**
 * File Changes API
 *
 * Endpoints for querying file changes tracked per session.
 * Also handles PreToolUse snapshot and PostToolUse diff requests
 * from hook scripts.
 */

import { Router } from "express";
import {
	snapshotFile,
	computeAndBroadcastDiff,
	getSessionDiffs,
	getSessionWindows,
	clearSessionDiffs,
	getSessionDiffSummary,
	rotateDiffWindow,
} from "../services/changes.js";

const router = Router();

// Snapshot a file before edit (called by PreToolUse hook)
router.post("/snapshot", (req, res) => {
	const { sessionId, filePath } = req.body;
	if (!sessionId || !filePath) {
		res.status(400).json({ error: "sessionId and filePath required" });
		return;
	}
	snapshotFile(sessionId, filePath);
	res.json({ ok: true });
});

// Compute diff after edit (called by PostToolUse hook)
router.post("/diff", (req, res) => {
	const { sessionId, filePath } = req.body;
	if (!sessionId || !filePath) {
		res.status(400).json({ error: "sessionId and filePath required" });
		return;
	}
	const diff = computeAndBroadcastDiff(sessionId, filePath);
	res.json({ ok: true, diff });
});

// Get all diffs for a session
router.get("/session/:sessionId", (req, res) => {
	const diffs = getSessionDiffs(req.params.sessionId);
	res.json({ diffs });
});

// Get summary (file count, total additions/deletions) for a session
router.get("/session/:sessionId/summary", (req, res) => {
	const summary = getSessionDiffSummary(req.params.sessionId);
	res.json(summary);
});

// Clear diffs for a session
router.post("/session/:sessionId/clear", (req, res) => {
	clearSessionDiffs(req.params.sessionId);
	res.json({ ok: true });
});

// Rotate to a new diff window (called by UserPromptSubmit hook)
router.post("/session/:sessionId/rotate", (req, res) => {
	rotateDiffWindow(req.params.sessionId);
	res.json({ ok: true });
});

// Get all windows (history) for a session
router.get("/session/:sessionId/windows", (req, res) => {
	const windows = getSessionWindows(req.params.sessionId);
	res.json({ windows });
});

export default router;
