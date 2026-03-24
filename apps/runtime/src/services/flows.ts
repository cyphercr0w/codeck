/**
 * Agent Flows — CRUD service
 *
 * Manages flow definitions, templates, and execution metadata.
 * Uses filesystem persistence with JSON files, following the same
 * patterns as memory.ts.
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { FlowDefinition, FlowExecution } from "../types/flow.types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Canonical paths ──

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const FLOWS_DIR = join(WORKSPACE, ".codeck", "flows", "definitions");
const TEMPLATES_DIR = join(WORKSPACE, ".codeck", "flows", "templates");
const EXECUTIONS_DIR = join(WORKSPACE, ".codeck", "flows", "executions");

// ── Helpers ──

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function readJsonFile<T>(filePath: string): T | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function writeJsonFile(filePath: string, data: unknown): void {
	ensureDir(join(filePath, ".."));
	writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function readFlowsFromDir(dir: string): FlowDefinition[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => readJsonFile<FlowDefinition>(join(dir, f)))
			.filter((flow): flow is FlowDefinition => flow !== null);
	} catch {
		return [];
	}
}

// ── Flow CRUD ──

/**
 * List all flow definitions (user-created + templates).
 */
export function listFlows(): FlowDefinition[] {
	const definitions = readFlowsFromDir(FLOWS_DIR);
	const templates = readFlowsFromDir(TEMPLATES_DIR);
	return [...definitions, ...templates];
}

/**
 * Get a single flow by ID. Searches definitions first, then templates.
 */
export function getFlow(id: string): FlowDefinition | null {
	const defPath = join(FLOWS_DIR, `${id}.json`);
	const found = readJsonFile<FlowDefinition>(defPath);
	if (found) return found;

	const tplPath = join(TEMPLATES_DIR, `${id}.json`);
	return readJsonFile<FlowDefinition>(tplPath);
}

/**
 * Create a new flow definition. Generates UUID, sets timestamps.
 */
export function createFlow(
	data: Omit<FlowDefinition, "id" | "createdAt" | "updatedAt">,
): FlowDefinition {
	const now = new Date().toISOString();
	const flow: FlowDefinition = {
		...data,
		id: randomUUID(),
		createdAt: now,
		updatedAt: now,
	};

	ensureDir(FLOWS_DIR);
	const filePath = join(FLOWS_DIR, `${flow.id}.json`);
	writeJsonFile(filePath, flow);

	return flow;
}

/**
 * Update an existing flow definition. Cannot update templates.
 */
export function updateFlow(
	id: string,
	data: Partial<FlowDefinition>,
): FlowDefinition {
	const filePath = join(FLOWS_DIR, `${id}.json`);
	const existing = readJsonFile<FlowDefinition>(filePath);

	if (!existing) {
		// Check if it's a template — templates cannot be updated
		const tplPath = join(TEMPLATES_DIR, `${id}.json`);
		if (existsSync(tplPath)) {
			throw new Error("Cannot update a template flow");
		}
		throw new Error(`Flow not found: ${id}`);
	}

	const updated: FlowDefinition = {
		...existing,
		...data,
		id: existing.id, // Prevent ID override
		createdAt: existing.createdAt, // Prevent createdAt override
		updatedAt: new Date().toISOString(),
	};

	writeJsonFile(filePath, updated);
	return updated;
}

/**
 * Delete a flow definition. Cannot delete templates. Returns true if deleted.
 */
export function deleteFlow(id: string): boolean {
	const filePath = join(FLOWS_DIR, `${id}.json`);

	if (!existsSync(filePath)) {
		// Check if it's a template — templates cannot be deleted
		const tplPath = join(TEMPLATES_DIR, `${id}.json`);
		if (existsSync(tplPath)) {
			return false; // Cannot delete templates
		}
		return false; // Not found
	}

	try {
		unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}

// ── Execution CRUD ──

/**
 * List executions, optionally filtered by flowId.
 */
export function listExecutions(flowId?: string): FlowExecution[] {
	if (!existsSync(EXECUTIONS_DIR)) return [];

	try {
		const execDirs = readdirSync(EXECUTIONS_DIR);
		const executions: FlowExecution[] = [];

		for (const dir of execDirs) {
			const metaPath = join(EXECUTIONS_DIR, dir, "meta.json");
			const execution = readJsonFile<FlowExecution>(metaPath);
			if (!execution) continue;
			if (flowId && execution.flowId !== flowId) continue;
			executions.push(execution);
		}

		return executions.sort(
			(a, b) =>
				new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
		);
	} catch {
		return [];
	}
}

/**
 * Get a single execution by ID.
 */
export function getExecution(execId: string): FlowExecution | null {
	const metaPath = join(EXECUTIONS_DIR, execId, "meta.json");
	return readJsonFile<FlowExecution>(metaPath);
}

/**
 * Save (create or update) an execution's meta.json.
 */
export function saveExecution(execution: FlowExecution): void {
	const execDir = join(EXECUTIONS_DIR, execution.id);
	ensureDir(execDir);
	const metaPath = join(execDir, "meta.json");
	writeJsonFile(metaPath, execution);
}

// ── Templates ──

/**
 * Initialize built-in flow templates. Copies to TEMPLATES_DIR if not
 * already present. Called once at startup.
 */
export function initFlowTemplates(): void {
	ensureDir(TEMPLATES_DIR);

	const codeReviewId = "00000000-0000-0000-0000-000000000001";
	const codeReviewPath = join(TEMPLATES_DIR, `${codeReviewId}.json`);

	if (!existsSync(codeReviewPath)) {
		const now = new Date().toISOString();
		const template: FlowDefinition = {
			id: codeReviewId,
			name: "Code Review",
			description:
				"Implements a feature then reviews it in a loop until the reviewer approves.",
			version: "1.0.0",
			isTemplate: true,
			createdAt: now,
			updatedAt: now,
			entryAgentId: "implementer",
			agents: {
				implementer: {
					id: "implementer",
					name: "Implementer",
					role: "Senior Developer",
					systemPrompt:
						"You are a senior developer. Implement the requested feature following best practices.",
					inputTemplate: "{{flow_context}}\n\nTask: {{prev_output}}",
					allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
					mcpServers: [],
					maxTurns: 50,
					timeoutMs: 300000,
					outputParser: "raw",
					transitions: {
						default: "reviewer",
					},
				},
				reviewer: {
					id: "reviewer",
					name: "Code Reviewer",
					role: "Code Reviewer",
					systemPrompt:
						"You are a code reviewer. Review the implementation for correctness, style, and best practices. Respond with APPROVE or REQUEST_CHANGES.",
					inputTemplate:
						"Review the following implementation:\n\n{{prev_output}}",
					allowedTools: ["Read", "Glob", "Grep"],
					mcpServers: [],
					maxTurns: 20,
					timeoutMs: 120000,
					outputParser: "structured",
					structuredOutputSchema: {
						decisionField: "decision",
						decisionsEnum: ["APPROVE", "REQUEST_CHANGES"],
					},
					transitions: {
						conditions: [
							{ when: "APPROVE", goto: "END" },
							{ when: "REQUEST_CHANGES", goto: "implementer" },
						],
					},
				},
			},
		};

		writeJsonFile(codeReviewPath, template);
		console.log("[Flows] Initialized code-review template");
	}

	const tddId = "00000000-0000-0000-0000-000000000002";
	const tddPath = join(TEMPLATES_DIR, `${tddId}.json`);

	if (!existsSync(tddPath)) {
		const now = new Date().toISOString();
		const template: FlowDefinition = {
			id: tddId,
			name: "TDD Cycle",
			description:
				"Test-driven development: write tests (RED), implement (GREEN), refactor (IMPROVE).",
			version: "1.0.0",
			isTemplate: true,
			createdAt: now,
			updatedAt: now,
			entryAgentId: "test-writer",
			agents: {
				"test-writer": {
					id: "test-writer",
					name: "Test Writer",
					role: "TDD Guide",
					systemPrompt:
						"You write failing tests first. Focus on behavior, not implementation details.",
					inputTemplate: "{{flow_context}}\n\nRequirement: {{prev_output}}",
					allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
					mcpServers: [],
					maxTurns: 30,
					timeoutMs: 180000,
					outputParser: "raw",
					transitions: {
						default: "implementer",
					},
				},
				implementer: {
					id: "implementer",
					name: "Implementer",
					role: "Developer",
					systemPrompt:
						"Write the minimal implementation to make the failing tests pass.",
					inputTemplate: "Make these tests pass:\n\n{{prev_output}}",
					allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
					mcpServers: [],
					maxTurns: 50,
					timeoutMs: 300000,
					outputParser: "raw",
					transitions: {
						default: "refactorer",
					},
				},
				refactorer: {
					id: "refactorer",
					name: "Refactorer",
					role: "Senior Developer",
					systemPrompt:
						"Refactor the code for clarity and performance. All tests must still pass. Respond with DONE or NEEDS_MORE.",
					inputTemplate: "Refactor this implementation:\n\n{{prev_output}}",
					allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
					mcpServers: [],
					maxTurns: 30,
					timeoutMs: 180000,
					outputParser: "structured",
					structuredOutputSchema: {
						decisionField: "decision",
						decisionsEnum: ["DONE", "NEEDS_MORE"],
					},
					transitions: {
						conditions: [
							{ when: "DONE", goto: "END" },
							{ when: "NEEDS_MORE", goto: "refactorer" },
						],
					},
				},
			},
		};

		writeJsonFile(tddPath, template);
		console.log("[Flows] Initialized tdd-cycle template");
	}

	// Copy JSON templates from dist/templates/flows/ to the runtime templates directory
	// These include fullstack-builder and interviewer-to-build
	try {
		const distTemplatesDir = join(__dirname, "..", "templates", "flows");
		if (existsSync(distTemplatesDir)) {
			const files = readdirSync(distTemplatesDir).filter((f) =>
				f.endsWith(".json"),
			);
			for (const file of files) {
				const srcPath = join(distTemplatesDir, file);
				const tpl = readJsonFile<FlowDefinition>(srcPath);
				if (tpl?.id) {
					const destPath = join(TEMPLATES_DIR, `${tpl.id}.json`);
					if (!existsSync(destPath)) {
						writeJsonFile(destPath, tpl);
						console.log(`[Flows] Copied template: ${tpl.name} (${tpl.id})`);
					}
				}
			}
		}
	} catch (err) {
		console.warn(
			"[Flows] Failed to copy dist templates:",
			(err as Error).message,
		);
	}

	// Clean up zombie executions — mark "running" executions as failed on startup
	// (they can't still be running if the server just started)
	try {
		const execs = listExecutions();
		for (const exec of execs) {
			if (exec.status === "running" || exec.status === "pending") {
				exec.status = "failed";
				exec.completedAt = new Date().toISOString();
				saveExecution(exec);
				console.log(`[Flows] Cleaned zombie execution: ${exec.id}`);
			}
		}
	} catch {
		/* non-fatal */
	}
}
