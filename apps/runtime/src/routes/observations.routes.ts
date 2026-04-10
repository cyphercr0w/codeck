import { Router } from "express";
import {
	captureObservation,
	searchObservations,
	getObservation,
	getObservationsByIds,
	listObservations,
	getObservationStats,
	isObservationsAvailable,
	type ObservationType,
} from "../services/observations.js";

const router = Router();

type AsyncHandler = (
	req: import("express").Request,
	res: import("express").Response,
) => Promise<void>;
const asyncHandler =
	(fn: AsyncHandler): AsyncHandler =>
	(req, res) =>
		fn(req, res).catch((err) => {
			console.error("[Observations API] Unhandled error:", err);
			if (!res.headersSent)
				res
					.status(500)
					.json({ error: "Observation operation failed. Please try again." });
		});

const VALID_TYPES = new Set([
	"feature",
	"bugfix",
	"discovery",
	"decision",
	"change",
]);

// POST /api/observations/capture — capture new observation (from hook)
router.post(
	"/capture",
	asyncHandler(async (req, res) => {
		if (!isObservationsAvailable()) {
			res.status(503).json({ error: "Observations not available" });
			return;
		}

		const { session_id, tool, type, title, files, concepts, narrative } =
			req.body;

		if (typeof session_id !== "string" || !session_id) {
			res.status(400).json({ error: "session_id is required" });
			return;
		}
		if (typeof tool !== "string" || !tool) {
			res.status(400).json({ error: "tool is required" });
			return;
		}
		if (type && !VALID_TYPES.has(type)) {
			res.status(400).json({
				error: `Invalid type. Must be one of: ${[...VALID_TYPES].join(", ")}`,
			});
			return;
		}

		const id = captureObservation({
			session_id,
			tool,
			type: type as ObservationType | undefined,
			title: typeof title === "string" ? title.slice(0, 500) : undefined,
			files: typeof files === "string" ? files.slice(0, 2000) : undefined,
			concepts:
				typeof concepts === "string" ? concepts.slice(0, 1000) : undefined,
			narrative:
				typeof narrative === "string" ? narrative.slice(0, 5000) : undefined,
		});

		res.status(201).json({ id });
	}),
);

// GET /api/observations/search — compact index (progressive disclosure step 1)
router.get("/search", (_req, res) => {
	if (!isObservationsAvailable()) {
		res.status(503).json({ error: "Observations not available" });
		return;
	}

	const query = String(_req.query.query || "");
	const type = _req.query.type as ObservationType | undefined;
	const limit = Math.min(Number(_req.query.limit) || 20, 100);
	const offset = Number(_req.query.offset) || 0;

	if (type && !VALID_TYPES.has(type)) {
		res.status(400).json({ error: "Invalid type filter" });
		return;
	}

	const results = searchObservations({ query, type, limit, offset });
	res.json({ results, total: results.length, query });
});

// GET /api/observations/stats
router.get("/stats", (_req, res) => {
	res.json(getObservationStats());
});

// POST /api/observations/batch — batch fetch by IDs (progressive disclosure step 3)
router.post("/batch", (_req, res) => {
	if (!isObservationsAvailable()) {
		res.status(503).json({ error: "Observations not available" });
		return;
	}

	const { ids } = _req.body;
	if (!Array.isArray(ids) || ids.length === 0) {
		res.status(400).json({ error: "ids must be a non-empty array of numbers" });
		return;
	}

	const safeIds = ids
		.filter((id: unknown) => typeof id === "number" && Number.isInteger(id))
		.slice(0, 100);

	const observations = getObservationsByIds(safeIds);
	res.json({ observations });
});

// GET /api/observations/:id — full detail (progressive disclosure step 2)
router.get("/:id", (_req, res) => {
	if (!isObservationsAvailable()) {
		res.status(503).json({ error: "Observations not available" });
		return;
	}

	const id = Number(_req.params.id);
	if (!Number.isInteger(id) || id < 1) {
		res.status(400).json({ error: "Invalid observation ID" });
		return;
	}

	const observation = getObservation(id);
	if (!observation) {
		res.status(404).json({ error: "Observation not found" });
		return;
	}

	res.json(observation);
});

// GET /api/observations — list recent (compact)
router.get("/", (_req, res) => {
	if (!isObservationsAvailable()) {
		res.status(503).json({ error: "Observations not available" });
		return;
	}

	const type = _req.query.type as ObservationType | undefined;
	const limit = Math.min(Number(_req.query.limit) || 50, 200);
	const offset = Number(_req.query.offset) || 0;
	const since = _req.query.since ? Number(_req.query.since) : undefined;

	if (type && !VALID_TYPES.has(type)) {
		res.status(400).json({ error: "Invalid type filter" });
		return;
	}

	const observations = listObservations({ type, limit, offset, since });
	res.json({ observations });
});

export default router;
