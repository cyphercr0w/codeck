/**
 * Agent Teams REST API
 *
 * CRUD for team templates + execution management.
 * Teams are parallel agent groups powered by Claude Code Agent Teams.
 */
import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import {
	listTeamTemplates,
	getTeamTemplate,
	createTeamTemplate,
	updateTeamTemplate,
	deleteTeamTemplate,
	listTeamExecutions,
	getTeamExecution,
} from "../services/teams.js";
import {
	launchTeam,
	launchAdHocTeam,
	stopTeam,
	getActiveTeamExecutions,
} from "../services/tmux-bridge.js";
import { resolve } from "path";

const router = Router();
const WORKSPACE = process.env.WORKSPACE || "/workspace";

// ── Executions (registered before /:id to avoid route shadowing) ──

/** List executions (active + persisted) */
router.get(
	"/executions/list",
	asyncHandler(async (_req, res) => {
		const persisted = listTeamExecutions();
		const active = getActiveTeamExecutions();
		// Merge: active take precedence over persisted
		const activeIds = new Set(active.map((e) => e.id));
		const merged = [
			...active,
			...persisted.filter((e) => !activeIds.has(e.id)),
		];
		res.json({ executions: merged });
	}),
);

router.get(
	"/executions/:execId",
	asyncHandler(async (req, res) => {
		const id = (req.params.execId ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
		const execution = getTeamExecution(id);
		if (!execution) {
			res.status(404).json({ error: "Execution not found" });
			return;
		}
		res.json(execution);
	}),
);

// ── Stop ──

router.post(
	"/executions/:execId/stop",
	asyncHandler(async (req, res) => {
		const id = (req.params.execId ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
		const stopped = stopTeam(id);
		if (!stopped) {
			res.status(404).json({ error: "Execution not found or already stopped" });
			return;
		}
		res.json({ ok: true, status: "cancelled" });
	}),
);

// ── Template CRUD ──

/** List all team templates */
router.get(
	"/",
	asyncHandler(async (_req, res) => {
		const templates = listTeamTemplates();
		res.json({ templates });
	}),
);

/** Get a single template */
router.get(
	"/:id",
	asyncHandler(async (req, res) => {
		const id = (req.params.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
		const template = getTeamTemplate(id);
		if (!template) {
			res.status(404).json({ error: "Team template not found" });
			return;
		}
		res.json(template);
	}),
);

/** Create a new template */
router.post(
	"/",
	asyncHandler(async (req, res) => {
		const { name, description, agents } = req.body ?? {};

		if (!name || typeof name !== "string" || !name.trim()) {
			res.status(400).json({ error: "name is required" });
			return;
		}
		if (
			!agents ||
			typeof agents !== "object" ||
			Object.keys(agents).length === 0
		) {
			res.status(400).json({ error: "agents must be a non-empty object" });
			return;
		}

		for (const [agentId, agent] of Object.entries(agents)) {
			const a = agent as Record<string, unknown>;
			if (!a.name || typeof a.name !== "string") {
				res
					.status(400)
					.json({ error: `Agent "${agentId}" must have a string name` });
				return;
			}
			if (!a.role || typeof a.role !== "string") {
				res
					.status(400)
					.json({ error: `Agent "${agentId}" must have a string role` });
				return;
			}
			if (!a.systemPrompt || typeof a.systemPrompt !== "string") {
				res.status(400).json({
					error: `Agent "${agentId}" must have a string systemPrompt`,
				});
				return;
			}
			if (
				a.allowedTools !== undefined &&
				(!Array.isArray(a.allowedTools) ||
					!(a.allowedTools as unknown[]).every((t) => typeof t === "string"))
			) {
				res
					.status(400)
					.json({ error: `Agent "${agentId}" allowedTools must be an array` });
				return;
			}
		}

		const template = createTeamTemplate({
			name: name.trim(),
			description: typeof description === "string" ? description.trim() : "",
			agents,
		});
		res.status(201).json(template);
	}),
);

/** Update a template */
router.put(
	"/:id",
	asyncHandler(async (req, res) => {
		const id = (req.params.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
		const updated = updateTeamTemplate(id, req.body ?? {});
		if (!updated) {
			res.status(404).json({ error: "Team template not found" });
			return;
		}
		res.json(updated);
	}),
);

/** Delete a template */
router.delete(
	"/:id",
	asyncHandler(async (req, res) => {
		const id = (req.params.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
		const deleted = deleteTeamTemplate(id);
		if (!deleted) {
			res.status(404).json({ error: "Team template not found" });
			return;
		}
		res.json({ ok: true });
	}),
);

// ── Launch ──

/** Launch a team from a template */
router.post(
	"/:id/launch",
	asyncHandler(async (req, res) => {
		const id = (req.params.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
		const template = getTeamTemplate(id);
		if (!template) {
			res.status(404).json({ error: "Team template not found" });
			return;
		}

		const { input, cwd } = req.body ?? {};

		// Validate cwd if provided
		if (cwd && typeof cwd === "string") {
			const resolved = resolve(cwd);
			if (!resolved.startsWith(WORKSPACE)) {
				res.status(400).json({ error: "cwd must be within workspace" });
				return;
			}
		}

		const execution = launchTeam(template, {
			cwd: typeof cwd === "string" ? cwd : undefined,
			input: typeof input === "string" ? input : undefined,
		});

		res.status(202).json({
			executionId: execution.id,
			templateId: template.id,
			templateName: template.name,
			status: execution.status,
			leaderSessionId: execution.leaderSessionId,
		});
	}),
);

/** Launch an ad-hoc team (no template required) */
router.post(
	"/launch-inline",
	asyncHandler(async (req, res) => {
		const { agents, name, input, cwd } = req.body ?? {};

		if (
			!agents ||
			typeof agents !== "object" ||
			Object.keys(agents).length === 0
		) {
			res.status(400).json({ error: "agents must be a non-empty object" });
			return;
		}

		// Validate each agent (same checks as POST /api/teams)
		for (const [agentId, agent] of Object.entries(agents)) {
			const a = agent as Record<string, unknown>;
			if (!a.name || typeof a.name !== "string") {
				res
					.status(400)
					.json({ error: `Agent "${agentId}" must have a string name` });
				return;
			}
			if (!a.role || typeof a.role !== "string") {
				res
					.status(400)
					.json({ error: `Agent "${agentId}" must have a string role` });
				return;
			}
			if (!a.systemPrompt || typeof a.systemPrompt !== "string") {
				res.status(400).json({
					error: `Agent "${agentId}" must have a string systemPrompt`,
				});
				return;
			}
			if (
				a.allowedTools !== undefined &&
				(!Array.isArray(a.allowedTools) ||
					!(a.allowedTools as unknown[]).every((t) => typeof t === "string"))
			) {
				res
					.status(400)
					.json({ error: `Agent "${agentId}" allowedTools must be an array` });
				return;
			}
		}

		// Validate cwd (prevent path traversal)
		if (cwd && typeof cwd === "string") {
			const resolved = resolve(cwd);
			if (!resolved.startsWith(WORKSPACE)) {
				res.status(400).json({ error: "cwd must be within workspace" });
				return;
			}
		}

		const execution = launchAdHocTeam(agents, {
			name: typeof name === "string" ? name : undefined,
			cwd: typeof cwd === "string" ? cwd : undefined,
			input: typeof input === "string" ? input : undefined,
		});

		res.status(202).json({
			executionId: execution.id,
			status: execution.status,
			leaderSessionId: execution.leaderSessionId,
		});
	}),
);

export default router;
