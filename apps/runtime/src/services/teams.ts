/**
 * Agent Teams — CRUD service
 *
 * Manages team templates and execution metadata.
 * Templates define parallel agent groups for Claude Code Agent Teams.
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
import { randomUUID } from "crypto";
import type { TeamTemplate, TeamExecution } from "../types/team.types.js";

// ── Paths ──

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const TEMPLATES_DIR = join(WORKSPACE, ".codeck", "teams", "templates");
const EXECUTIONS_DIR = join(WORKSPACE, ".codeck", "teams", "executions");

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
	ensureDir(dirname(filePath));
	writeFileSync(filePath, JSON.stringify(data, null, "\t"), { mode: 0o600 });
}

function readTemplatesFromDir(dir: string): TeamTemplate[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => readJsonFile<TeamTemplate>(join(dir, f)))
			.filter((t): t is TeamTemplate => t !== null);
	} catch {
		return [];
	}
}

// ── Template CRUD ──

export function listTeamTemplates(): TeamTemplate[] {
	return readTemplatesFromDir(TEMPLATES_DIR);
}

export function getTeamTemplate(id: string): TeamTemplate | null {
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
	return readJsonFile<TeamTemplate>(join(TEMPLATES_DIR, `${safeId}.json`));
}

export function createTeamTemplate(
	data: Pick<TeamTemplate, "name" | "description" | "agents">,
): TeamTemplate {
	const now = new Date().toISOString();
	const template: TeamTemplate = {
		id: randomUUID(),
		name: data.name,
		description: data.description,
		version: "1.0.0",
		isTemplate: true,
		createdAt: now,
		updatedAt: now,
		agents: data.agents,
	};
	writeJsonFile(join(TEMPLATES_DIR, `${template.id}.json`), template);
	return template;
}

export function updateTeamTemplate(
	id: string,
	data: Partial<Pick<TeamTemplate, "name" | "description" | "agents">>,
): TeamTemplate | null {
	const existing = getTeamTemplate(id);
	if (!existing) return null;

	const updated: TeamTemplate = {
		...existing,
		...(data.name !== undefined && { name: data.name }),
		...(data.description !== undefined && { description: data.description }),
		...(data.agents !== undefined && { agents: data.agents }),
		updatedAt: new Date().toISOString(),
	};
	writeJsonFile(join(TEMPLATES_DIR, `${existing.id}.json`), updated);
	return updated;
}

export function deleteTeamTemplate(id: string): boolean {
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
	const filePath = join(TEMPLATES_DIR, `${safeId}.json`);
	if (!existsSync(filePath)) return false;
	unlinkSync(filePath);
	return true;
}

// ── Execution Persistence ──

export function saveTeamExecution(execution: TeamExecution): void {
	writeJsonFile(join(EXECUTIONS_DIR, `${execution.id}.json`), execution);
}

export function getTeamExecution(id: string): TeamExecution | null {
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
	return readJsonFile<TeamExecution>(join(EXECUTIONS_DIR, `${safeId}.json`));
}

export function listTeamExecutions(): TeamExecution[] {
	if (!existsSync(EXECUTIONS_DIR)) return [];
	try {
		return readdirSync(EXECUTIONS_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => readJsonFile<TeamExecution>(join(EXECUTIONS_DIR, f)))
			.filter((e): e is TeamExecution => e !== null)
			.sort(
				(a, b) =>
					new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
			);
	} catch {
		return [];
	}
}

// ── Init ──

export function initTeamTemplates(): void {
	ensureDir(TEMPLATES_DIR);
	ensureDir(EXECUTIONS_DIR);

	// Built-in: Security Audit Team
	const auditId = "tpl-security-audit";
	if (!existsSync(join(TEMPLATES_DIR, `${auditId}.json`))) {
		const template: TeamTemplate = {
			id: auditId,
			name: "Security Audit",
			description:
				"Security auditor analyzes code for vulnerabilities, reviewer validates findings.",
			version: "1.0.0",
			isTemplate: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			agents: {
				auditor: {
					id: "auditor",
					name: "Security Auditor",
					role: "Security Expert",
					systemPrompt:
						"You are a security auditor. Perform a thorough security audit of the target files. Check for: command injection, path traversal, DoS vectors, authentication bypass, input validation gaps. Report each finding with severity (CRITICAL/HIGH/MEDIUM/LOW), file:line reference, and a concrete fix recommendation. Send your findings to the reviewer when done.",
					allowedTools: ["Read", "Glob", "Grep", "Bash"],
				},
				reviewer: {
					id: "reviewer",
					name: "Audit Reviewer",
					role: "Senior Security Reviewer",
					systemPrompt:
						"You are a senior security reviewer. Wait for the auditor to send findings. Then review the audit: are findings accurate? Are there false positives? Did the auditor miss anything? Cross-check by reading the actual source code. Produce a final validated report with only confirmed issues and send it to the team lead.",
					allowedTools: ["Read", "Glob", "Grep"],
				},
			},
		};
		writeJsonFile(join(TEMPLATES_DIR, `${auditId}.json`), template);
	}

	// Built-in: Code Review Team
	const reviewId = "tpl-code-review";
	if (!existsSync(join(TEMPLATES_DIR, `${reviewId}.json`))) {
		const template: TeamTemplate = {
			id: reviewId,
			name: "Code Review",
			description:
				"Reviewer analyzes code for bugs and quality, implementer fixes issues found.",
			version: "1.0.0",
			isTemplate: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			agents: {
				reviewer: {
					id: "reviewer",
					name: "Code Reviewer",
					role: "Expert Code Reviewer",
					systemPrompt:
						"You are an expert code reviewer. Review the target files for bugs, type safety, error handling, security, and performance. List each issue with severity (CRITICAL/HIGH/MEDIUM/LOW) and file:line references. Send your findings to the implementer when done.",
					allowedTools: ["Read", "Glob", "Grep", "Bash"],
				},
				implementer: {
					id: "implementer",
					name: "Implementer",
					role: "Senior Developer",
					systemPrompt:
						"You are a senior developer. Wait for the reviewer to send findings. Fix all CRITICAL and HIGH issues. Make minimal focused changes. After fixing, run the build to verify. Send a summary of changes to the team lead.",
					allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
				},
			},
		};
		writeJsonFile(join(TEMPLATES_DIR, `${reviewId}.json`), template);
	}
}
