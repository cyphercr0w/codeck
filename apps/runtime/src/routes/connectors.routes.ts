import { Router } from "express";
import {
	syncAll,
	syncConnector,
	getConnectorStatus,
} from "../services/memory-connectors.js";

const router = Router();

// Express 4 doesn't catch rejected promises from async handlers.
// Wrap to ensure unhandled errors return 500 instead of crashing.
type AsyncHandler = (
	req: import("express").Request,
	res: import("express").Response,
) => Promise<void>;
const asyncHandler =
	(fn: AsyncHandler): AsyncHandler =>
	(req, res) =>
		fn(req, res).catch((err) => {
			console.error("[Connectors API] Unhandled error:", err);
			if (!res.headersSent)
				res.status(500).json({ error: "Connector operation failed" });
		});

// GET /api/memory/connectors — list all connectors and their status
router.get("/", (_req, res) => {
	res.json({ connectors: getConnectorStatus() });
});

// POST /api/memory/connectors/sync — sync all connectors
router.post(
	"/sync",
	asyncHandler(async (_req, res) => {
		const results = await syncAll();
		res.json({ results });
	}),
);

// POST /api/memory/connectors/:name/sync — sync specific connector
router.post(
	"/:name/sync",
	asyncHandler(async (req, res) => {
		const name = req.params.name.replace(/[^a-zA-Z0-9_\-]/g, "");
		if (!name) {
			res.status(400).json({ error: "Invalid connector name" });
			return;
		}
		const result = await syncConnector(name);
		if (
			result.errors.length > 0 &&
			result.filesScanned === 0 &&
			result.filesIndexed === 0
		) {
			const notFound = result.errors.find((e) =>
				e.startsWith("Connector not found"),
			);
			if (notFound) {
				res.status(404).json({ error: notFound });
				return;
			}
		}
		res.json(result);
	}),
);

export default router;
