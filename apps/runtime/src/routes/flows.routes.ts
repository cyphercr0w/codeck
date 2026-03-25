/**
 * Agent Flows REST API
 *
 * CRUD for flow definitions + execution management.
 * Designed to be invoked from both the web UI and a future chat interface.
 */
import { Router } from "express";
import type { FlowExecution } from "../types/flow.types.js";
import {
	listFlows,
	getFlow,
	createFlow,
	updateFlow,
	deleteFlow,
	listExecutions,
	getExecution,
	saveExecution,
} from "../services/flows.js";
import { runFlow, cancelExecution } from "../services/flow-runner.js";
import { broadcast } from "../web/logger.js";
import { randomUUID } from "crypto";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const router = Router();

// ── Available Agents (from ~/.claude/agents/) ──

interface AvailableAgent {
	id: string;
	name: string;
	description: string;
	tools: string[];
}

function listAvailableAgents(): AvailableAgent[] {
	const agentsDir = join(process.env.HOME || "/root", ".claude", "agents");
	if (!existsSync(agentsDir)) return [];
	try {
		return readdirSync(agentsDir)
			.filter((f) => f.endsWith(".md") && /^[a-zA-Z0-9_-]+\.md$/.test(f))
			.map((f) => {
				const id = f.replace(".md", "");
				const content = readFileSync(join(agentsDir, f), "utf-8");
				const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
				let description = "";
				let tools: string[] = [];
				if (fmMatch) {
					const fm = fmMatch[1];
					const descMatch = fm.match(/description:\s*(.+)/);
					if (descMatch) description = descMatch[1].trim();
					const toolsMatch = fm.match(/tools:\s*\[([^\]]*)\]/);
					if (toolsMatch) {
						tools = toolsMatch[1]
							.split(",")
							.map((t) => t.trim().replace(/["']/g, ""))
							.filter(Boolean);
					}
				}
				const name = id
					.split("-")
					.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
					.join(" ");
				return { id, name, description, tools };
			})
			.filter((a) => a.description);
	} catch {
		return [];
	}
}

router.get("/available-agents", (_req, res) => {
	res.json({ agents: listAvailableAgents() });
});

// ── Flow Definitions CRUD ──

// List all flows (user-created + templates)
router.get("/", (_req, res) => {
	try {
		res.json({ flows: listFlows() });
	} catch (e) {
		res.status(500).json({ error: (e as Error).message });
	}
});

// Sanitize IDs to prevent path traversal
function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9\-]/g, "");
}

// Get single flow
router.get("/:id", (req, res) => {
	const flow = getFlow(safeId(req.params.id));
	if (!flow) {
		res.status(404).json({ error: "Flow not found" });
		return;
	}
	res.json(flow);
});

// Create new flow
router.post("/", (req, res) => {
	try {
		const body = req.body;
		// Validate required fields
		if (!body || typeof body !== "object") {
			res.status(400).json({ error: "Request body must be a JSON object" });
			return;
		}
		if (typeof body.name !== "string" || !body.name.trim()) {
			res.status(400).json({ error: "name (string) is required" });
			return;
		}
		if (
			!body.agents ||
			typeof body.agents !== "object" ||
			Array.isArray(body.agents) ||
			Object.keys(body.agents).length === 0
		) {
			res.status(400).json({ error: "agents (non-empty object) is required" });
			return;
		}
		if (
			typeof body.entryAgentId !== "string" ||
			!body.agents[body.entryAgentId]
		) {
			res
				.status(400)
				.json({ error: "entryAgentId must reference a valid agent" });
			return;
		}
		const flow = createFlow(body);
		res.status(201).json(flow);
	} catch (e) {
		res.status(400).json({ error: (e as Error).message });
	}
});

// Update flow (cannot update templates)
router.put("/:id", (req, res) => {
	try {
		const flow = updateFlow(safeId(req.params.id), req.body);
		if (!flow) {
			res.status(404).json({ error: "Flow not found or is a template" });
			return;
		}
		res.json(flow);
	} catch (e) {
		res.status(400).json({ error: (e as Error).message });
	}
});

// Delete flow (cannot delete templates)
router.delete("/:id", (req, res) => {
	const deleted = deleteFlow(safeId(req.params.id));
	if (!deleted) {
		res.status(404).json({ error: "Flow not found or is a template" });
		return;
	}
	res.json({ success: true });
});

// ── Flow Execution ──

// Start a new execution
router.post("/:id/execute", async (req, res) => {
	const flow = getFlow(safeId(req.params.id));
	if (!flow) {
		res.status(404).json({ error: "Flow not found" });
		return;
	}

	const { input, cwd: rawCwd } = req.body;
	if (!input || typeof input !== "string") {
		res.status(400).json({ error: "input (string) is required" });
		return;
	}

	// Validate cwd is within /workspace if provided
	const WORKSPACE = process.env.WORKSPACE || "/workspace";
	let cwd: string | undefined;
	if (rawCwd && typeof rawCwd === "string") {
		const resolved = resolve(rawCwd);
		if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + "/")) {
			res
				.status(400)
				.json({ error: "cwd must be within the workspace directory" });
			return;
		}
		cwd = resolved;
	}

	// Create execution record
	const execution: FlowExecution = {
		id: randomUUID(),
		flowId: flow.id,
		flowVersion: flow.version,
		status: "pending",
		currentAgentId: null,
		loopCount: 0,
		maxLoops: 5,
		startedAt: new Date().toISOString(),
		completedAt: null,
		initialInput: input,
		agentResults: {},
	};

	saveExecution(execution);

	// Build ordered agent list for progress tracking.
	// Walk default transitions first, then collect any agents only reachable
	// via conditional transitions (e.g. reviewer→implementer on REQUEST_CHANGES).
	const agentList: Array<{ id: string; name: string; role: string }> = [];
	{
		const visited = new Set<string>();
		const queue: string[] = [flow.entryAgentId];
		while (queue.length > 0) {
			const cursor = queue.shift()!;
			if (visited.has(cursor) || !flow.agents[cursor]) continue;
			const ag = flow.agents[cursor]!;
			agentList.push({ id: ag.id, name: ag.name, role: ag.role });
			visited.add(cursor);
			// Follow default transition
			const dflt = ag.transitions.default;
			if (typeof dflt === "string" && dflt !== "END") {
				queue.push(dflt);
			}
			// Follow conditional transitions
			if (ag.transitions.conditions) {
				for (const cond of ag.transitions.conditions) {
					if (cond.goto !== "END") {
						queue.push(cond.goto);
					}
				}
			}
		}
	}

	// Broadcast flow started event so the frontend can track progress
	broadcast({
		type: "chat:flow:started",
		data: {
			chatId: "",
			conversationId: "",
			executionId: execution.id,
			flowId: flow.id,
			flowName: flow.name,
			agents: agentList,
			initialInput: input,
		},
	});

	res.status(202).json({
		executionId: execution.id,
		flowId: flow.id,
		status: "pending",
	});

	// Run asynchronously — errors are caught and saved to execution state
	runFlow(execution, flow, cwd).catch((err: unknown) => {
		console.error(
			`[Flows] Execution ${execution.id} failed:`,
			(err as Error).message,
		);
	});
});

// List executions (optionally filtered by flowId)
router.get("/executions/list", (req, res) => {
	const flowId =
		typeof req.query.flowId === "string" ? req.query.flowId : undefined;
	try {
		res.json({ executions: listExecutions(flowId) });
	} catch (e) {
		res.status(500).json({ error: (e as Error).message });
	}
});

// Get execution status
router.get("/executions/:execId", (req, res) => {
	const execution = getExecution(safeId(req.params.execId));
	if (!execution) {
		res.status(404).json({ error: "Execution not found" });
		return;
	}
	res.json(execution);
});

// Cancel running execution
router.post("/executions/:execId/cancel", (req, res) => {
	const execution = getExecution(safeId(req.params.execId));
	if (!execution) {
		res.status(404).json({ error: "Execution not found" });
		return;
	}
	if (execution.status !== "running" && execution.status !== "pending") {
		res.status(400).json({ error: "Execution is not running" });
		return;
	}

	cancelExecution(safeId(req.params.execId));

	execution.status = "cancelled";
	execution.completedAt = new Date().toISOString();
	saveExecution(execution);

	broadcast({ type: "flow:execution:update", data: execution });
	res.json({ success: true, status: "cancelled" });
});

export default router;
