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
import { join } from "path";

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
		const flow = createFlow(req.body);
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

	const { input, cwd } = req.body;
	if (!input || typeof input !== "string") {
		res.status(400).json({ error: "input (string) is required" });
		return;
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

	// Build ordered agent list for progress tracking
	const agentList: Array<{ id: string; name: string; role: string }> = [];
	{
		const visited = new Set<string>();
		let cursor: string | undefined = flow.entryAgentId;
		while (cursor && !visited.has(cursor) && flow.agents[cursor]) {
			const ag = flow.agents[cursor]!;
			agentList.push({ id: ag.id, name: ag.name, role: ag.role });
			visited.add(cursor);
			const dflt: string | undefined = ag.transitions.default as
				| string
				| undefined;
			cursor = typeof dflt === "string" && dflt !== "END" ? dflt : undefined;
		}
	}

	// Broadcast flow started event so the frontend can track progress
	broadcast({
		type: "chat:flow:started",
		data: {
			chatId: "",
			conversationId: "",
			executionId: execution.id,
			flowName: flow.name,
			agents: agentList,
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
