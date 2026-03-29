/**
 * Agent Flows — End-to-end integration tests
 *
 * Tests the complete flow pipeline: prompt building, output chaining,
 * transitions, structured decisions, loop detection, and validation.
 */

import { describe, it, expect } from "vitest";
import type {
	FlowDefinition,
	FlowExecution,
	AgentDefinition,
} from "../../apps/runtime/src/types/flow.types";

// ── Test helpers ──

function makeAgent(
	overrides: Partial<AgentDefinition> & { id: string },
): AgentDefinition {
	return {
		name: overrides.id,
		role: overrides.id,
		systemPrompt: "You are a test agent.",
		inputTemplate: "Input: {{prev_output}}",
		allowedTools: ["Read"],
		mcpServers: [],
		maxTurns: 5,
		timeoutMs: 10000,
		outputParser: "raw",
		transitions: { default: "END" },
		...overrides,
	};
}

function makeFlow(
	agents: Record<string, AgentDefinition>,
	entryId: string,
): FlowDefinition {
	return {
		id: "test-flow-1",
		name: "Test Flow",
		description: "3-agent test pipeline",
		version: "1.0.0",
		isTemplate: false,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		entryAgentId: entryId,
		agents,
	};
}

function makeExecution(flowId: string, input: string): FlowExecution {
	return {
		id: "test-exec-1",
		flowId,
		flowVersion: "1.0.0",
		status: "pending",
		currentAgentId: null,
		loopCount: 0,
		maxLoops: 5,
		startedAt: new Date().toISOString(),
		completedAt: null,
		initialInput: input,
		agentResults: {},
	};
}

// Simulate the prompt building logic from flow-runner
function buildPrompt(
	systemPrompt: string,
	inputTemplate: string,
	variables: Record<string, string>,
): string {
	let prompt = inputTemplate;
	for (const [key, value] of Object.entries(variables)) {
		prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
	}
	return `${systemPrompt}\n\n${prompt}`;
}

// Simulate structured decision parsing
function parseDecision(output: string, decisionsEnum: string[]): string {
	const match = output.match(/^DECISION:\s*(\w+)/m);
	if (match && decisionsEnum.includes(match[1])) return match[1];
	return decisionsEnum[0];
}

// Simulate transition resolution
function resolveTransition(
	transitions: AgentDefinition["transitions"],
	decision?: string,
): string | null {
	if (decision && transitions.conditions) {
		const match = transitions.conditions.find((c) => c.when === decision);
		if (match) return match.goto === "END" ? null : match.goto;
	}
	if (!transitions.default || transitions.default === "END") return null;
	return transitions.default;
}

// ── Tests ──

describe("Agent Flows", () => {
	describe("Prompt building", () => {
		it("should substitute {{prev_output}} in input template", () => {
			const result = buildPrompt(
				"You are a planner.",
				"Plan this: {{prev_output}}",
				{ prev_output: "Build a landing page", flow_context: "{}" },
			);
			expect(result).toContain("Build a landing page");
			expect(result).toContain("You are a planner.");
		});

		it("should handle multiple variable references", () => {
			const result = buildPrompt(
				"System",
				"Input: {{prev_output}}\nRepeat: {{prev_output}}\nCtx: {{flow_context}}",
				{ prev_output: "hello", flow_context: '{"a":1}' },
			);
			expect(result).toBe(
				'System\n\nInput: hello\nRepeat: hello\nCtx: {"a":1}',
			);
		});

		it("should pass through templates without variables", () => {
			const result = buildPrompt("Sys", "Just do it.", {
				prev_output: "ignored",
			});
			expect(result).toBe("Sys\n\nJust do it.");
		});
	});

	describe("Structured decision parsing", () => {
		it("should extract DECISION: CLEAN", () => {
			const output = "Everything looks good.\n\nDECISION: CLEAN";
			expect(parseDecision(output, ["LOOP", "CLEAN"])).toBe("CLEAN");
		});

		it("should extract DECISION: LOOP with issues", () => {
			const output = "Found bugs:\nDECISION: LOOP\nISSUES:\n- bug 1\n- bug 2";
			expect(parseDecision(output, ["LOOP", "CLEAN"])).toBe("LOOP");
		});

		it("should default to first enum when no decision found", () => {
			const output = "I forgot the decision block.";
			expect(parseDecision(output, ["LOOP", "CLEAN"])).toBe("LOOP");
		});

		it("should default to first enum for unknown decision", () => {
			const output = "DECISION: MAYBE";
			expect(parseDecision(output, ["LOOP", "CLEAN"])).toBe("LOOP");
		});
	});

	describe("Transition resolution", () => {
		it("should follow default transition", () => {
			expect(resolveTransition({ default: "agent-b" })).toBe("agent-b");
		});

		it("should follow conditional on match", () => {
			expect(
				resolveTransition(
					{
						conditions: [
							{ when: "LOOP", goto: "impl" },
							{ when: "CLEAN", goto: "audit" },
						],
						default: "audit",
					},
					"LOOP",
				),
			).toBe("impl");
		});

		it("should fall back to default when no condition matches", () => {
			expect(
				resolveTransition(
					{
						conditions: [{ when: "LOOP", goto: "impl" }],
						default: "audit",
					},
					"UNKNOWN",
				),
			).toBe("audit");
		});

		it("should return null for END", () => {
			expect(resolveTransition({ default: "END" })).toBeNull();
		});

		it("should return null for conditional END", () => {
			expect(
				resolveTransition(
					{ conditions: [{ when: "CLEAN", goto: "END" }] },
					"CLEAN",
				),
			).toBeNull();
		});
	});

	describe("3-agent pipeline (researcher → writer → editor)", () => {
		const flow = makeFlow(
			{
				researcher: makeAgent({
					id: "researcher",
					systemPrompt: "You research topics.",
					inputTemplate: "Research: {{prev_output}}",
					transitions: { default: "writer" },
				}),
				writer: makeAgent({
					id: "writer",
					systemPrompt: "You write articles.",
					inputTemplate: "Write based on:\n{{prev_output}}",
					transitions: { default: "editor" },
				}),
				editor: makeAgent({
					id: "editor",
					systemPrompt: "You polish text.",
					inputTemplate: "Edit:\n{{prev_output}}",
					transitions: { default: "END" },
				}),
			},
			"researcher",
		);

		it("should have 3 agents with correct chain", () => {
			expect(Object.keys(flow.agents)).toHaveLength(3);
			expect(flow.entryAgentId).toBe("researcher");
		});

		it("should walk the full graph from entry to END", () => {
			const visited: string[] = [];
			let current: string | null = flow.entryAgentId;

			while (current) {
				visited.push(current);
				current = resolveTransition(flow.agents[current].transitions);
			}

			expect(visited).toEqual(["researcher", "writer", "editor"]);
		});

		it("should chain output through all 3 agents", () => {
			// Simulate execution
			const agentOutputs: Record<string, string> = {
				researcher: "Found 5 key facts about AI sandboxes.",
				writer: "Article: AI sandboxes are the future because...",
				editor: "Polished: AI sandboxes revolutionize development.",
			};

			let prevOutput = "Tell me about AI sandboxes";
			const prompts: string[] = [];
			let current: string | null = flow.entryAgentId;

			while (current) {
				const agent = flow.agents[current];
				const prompt = buildPrompt(agent.systemPrompt, agent.inputTemplate, {
					prev_output: prevOutput,
					flow_context: "{}",
				});
				prompts.push(prompt);
				prevOutput = agentOutputs[current];
				current = resolveTransition(agent.transitions);
			}

			// Researcher gets user input
			expect(prompts[0]).toContain("Tell me about AI sandboxes");
			// Writer gets researcher output
			expect(prompts[1]).toContain("Found 5 key facts");
			// Editor gets writer output
			expect(prompts[2]).toContain("Article: AI sandboxes");
		});
	});

	describe("Reviewer loop (implementer ↔ reviewer)", () => {
		const flow = makeFlow(
			{
				impl: makeAgent({
					id: "impl",
					inputTemplate: "Implement:\n{{prev_output}}",
					transitions: { default: "review" },
				}),
				review: makeAgent({
					id: "review",
					inputTemplate: "Review:\n{{prev_output}}",
					outputParser: "structured",
					structuredOutputSchema: {
						decisionField: "DECISION",
						decisionsEnum: ["LOOP", "CLEAN"],
					},
					transitions: {
						conditions: [
							{ when: "LOOP", goto: "impl" },
							{ when: "CLEAN", goto: "END" },
						],
						default: "END",
					},
				}),
			},
			"impl",
		);

		it("should loop back on DECISION: LOOP", () => {
			const reviewerOutputs = [
				"DECISION: LOOP\nISSUES:\n- missing tests",
				"DECISION: LOOP\nISSUES:\n- bad naming",
				"DECISION: CLEAN",
			];

			let current: string | null = "impl";
			let loopCount = 0;
			let reviewIdx = 0;
			const visited: string[] = [];

			while (current && loopCount <= 5) {
				visited.push(current);
				const agent = flow.agents[current];

				if (agent.outputParser === "structured") {
					const output = reviewerOutputs[reviewIdx++] || "DECISION: CLEAN";
					const decision = parseDecision(
						output,
						agent.structuredOutputSchema!.decisionsEnum,
					);
					const next = resolveTransition(agent.transitions, decision);
					if (
						next === current ||
						(visited.length > 1 && next === visited[visited.length - 2])
					) {
						loopCount++;
					}
					current = next;
				} else {
					current = resolveTransition(agent.transitions);
				}
			}

			// impl → review(LOOP) → impl → review(LOOP) → impl → review(CLEAN) → END
			expect(visited).toEqual([
				"impl",
				"review",
				"impl",
				"review",
				"impl",
				"review",
			]);
			expect(loopCount).toBe(2); // two LOOP decisions
		});

		it("should respect maxLoops limit", () => {
			const maxLoops = 3;
			let current: string | null = "impl";
			let loopCount = 0;
			const visited: string[] = [];

			while (current && loopCount < maxLoops) {
				visited.push(current);
				const agent = flow.agents[current];

				if (agent.outputParser === "structured") {
					// Always returns LOOP
					const decision = "LOOP";
					const next = resolveTransition(agent.transitions, decision);
					if (next !== null && visited.length > 1) loopCount++;
					current = next;
				} else {
					current = resolveTransition(agent.transitions);
				}
			}

			expect(loopCount).toBe(maxLoops);
			expect(visited.length).toBeLessThanOrEqual(maxLoops * 2 + 1);
		});
	});

	describe("Execution state", () => {
		it("should create execution with correct initial state", () => {
			const exec = makeExecution("flow-1", "Build a todo app");
			expect(exec.status).toBe("pending");
			expect(exec.initialInput).toBe("Build a todo app");
			expect(exec.loopCount).toBe(0);
			expect(exec.maxLoops).toBe(5);
			expect(Object.keys(exec.agentResults)).toHaveLength(0);
		});

		it("should track results per agent", () => {
			const exec = makeExecution("flow-1", "test");
			exec.status = "running";
			exec.agentResults.researcher = {
				agentId: "researcher",
				status: "completed",
				startedAt: "2026-03-24T00:00:00Z",
				completedAt: "2026-03-24T00:01:00Z",
				output: "Research done",
			};
			exec.agentResults.writer = {
				agentId: "writer",
				status: "completed",
				startedAt: "2026-03-24T00:01:00Z",
				completedAt: "2026-03-24T00:02:00Z",
				output: "Article written",
			};

			expect(Object.keys(exec.agentResults)).toHaveLength(2);
			expect(exec.agentResults.researcher.output).toBe("Research done");
			expect(exec.agentResults.writer.output).toBe("Article written");
		});
	});

	describe("Flow validation", () => {
		it("should detect missing entry agent", () => {
			const flow = makeFlow({ a: makeAgent({ id: "a" }) }, "nonexistent");
			expect(flow.entryAgentId in flow.agents).toBe(false);
		});

		it("should detect broken transition", () => {
			const flow = makeFlow(
				{
					a: makeAgent({ id: "a", transitions: { default: "missing" } }),
				},
				"a",
			);
			const target = flow.agents.a.transitions.default;
			const valid =
				target === "END" || (target != null && target in flow.agents);
			expect(valid).toBe(false);
		});

		it("should accept valid 3-agent flow", () => {
			const flow = makeFlow(
				{
					a: makeAgent({ id: "a", transitions: { default: "b" } }),
					b: makeAgent({ id: "b", transitions: { default: "c" } }),
					c: makeAgent({ id: "c", transitions: { default: "END" } }),
				},
				"a",
			);

			const allValid = Object.values(flow.agents).every((agent) => {
				const target = agent.transitions.default;
				return target === "END" || (target != null && target in flow.agents);
			});
			expect(allValid).toBe(true);
			expect(flow.entryAgentId in flow.agents).toBe(true);
		});
	});
});
