/**
 * Agent Mode handler — classifies intent, routes to flow or CLI spawn.
 */

import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { broadcast } from "../web/logger.js";
import {
	buildCleanEnv,
	getOAuthEnv,
	getValidAgentBinary,
} from "./claude-env.js";
import { classifyIntent } from "./intent-classifier.js";
import { getFlow, saveExecution } from "./flows.js";
import { runFlow, cancelExecution } from "./flow-runner.js";
import {
	readConversation,
	writeConversation,
	withConversationLock,
	MODEL_MAP,
} from "./conversation-storage.js";
import type { ChatConversation } from "../types/chat.types.js";
import type { FlowExecution } from "../types/flow.types.js";
import type { Response as ExpressResponse } from "express";

// Active chat processes (for cancellation)
export const activeChatProcesses = new Map<string, ChildProcess>();

// Maximum number of concurrent chat processes
export const MAX_CHAT_PROCESSES = 3;

export { cancelExecution };

export interface AgentModeParams {
	chatId: string;
	conversation: ChatConversation;
	prompt: string;
	message: string;
	model: string;
}

export function handleAgentMode(
	res: ExpressResponse,
	params: AgentModeParams,
): void {
	const { chatId, conversation, prompt, message, model } = params;

	// Validate model is a string to prevent injection via spawn args
	const cliModel =
		typeof model === "string" && model in MODEL_MAP ? model : "haiku";

	(async () => {
		try {
			const intent = await classifyIntent(message);
			console.log(
				`[Chat] Intent: ${intent.category} (${intent.confidence}) flow=${intent.flowTemplateId || "none"}`,
			);

			// If intent maps to a flow template, trigger flow execution
			if (intent.flowTemplateId) {
				const flow = getFlow(intent.flowTemplateId);
				if (flow) {
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
						initialInput: message,
						agentResults: {},
					};

					saveExecution(execution);

					// Link flow to conversation (immutable update)
					const linkedConversation: ChatConversation = {
						...conversation,
						flowExecutionId: execution.id,
						flowStatus: "running",
					};
					await writeConversation(linkedConversation);

					// Build ordered agent list by walking the graph from entryAgentId
					const agentList: Array<{
						id: string;
						name: string;
						role: string;
					}> = [];
					{
						const visited = new Set<string>();
						let cursor: string | undefined = flow.entryAgentId;
						while (cursor && !visited.has(cursor)) {
							const def = flow.agents[cursor] as
								| import("../types/flow.types.js").AgentDefinition
								| undefined;
							if (!def) break;
							agentList.push({
								id: def.id,
								name: def.name,
								role: def.role,
							});
							visited.add(cursor);
							const next = def.transitions.default;
							cursor =
								typeof next === "string" && next !== "END" ? next : undefined;
						}
					}

					// Broadcast flow started event for chat UI
					broadcast({
						type: "chat:flow:started",
						data: {
							chatId,
							conversationId: conversation.id,
							executionId: execution.id,
							flowId: flow.id,
							flowName: flow.name,
							agents: agentList,
						},
					});

					res.status(202).json({
						chatId,
						conversationId: conversation.id,
						executionId: execution.id,
						status: "flow-started",
						flowName: flow.name,
						flowAgents: agentList.map((a) => a.name),
					});

					// Run flow async — save result to conversation on completion
					const workspace = process.env.WORKSPACE || "/workspace";
					runFlow(execution, flow, workspace)
						.then(() =>
							withConversationLock(conversation.id, async () => {
								const freshConv = await readConversation(conversation.id);
								if (freshConv) {
									const finalExec = { ...execution };
									const outputs = Object.values(finalExec.agentResults)
										.filter((r) => r.output)
										.map(
											(r) => `**${r.agentId}**:\n${r.output.slice(0, 2000)}`,
										);
									if (outputs.length > 0) {
										const updated: ChatConversation = {
											...freshConv,
											flowStatus: "completed",
											updatedAt: new Date().toISOString(),
											messages: [
												...freshConv.messages,
												{
													id: randomUUID(),
													role: "assistant",
													content: `Flow "${flow.name}" completed.\n\n${outputs.join("\n\n---\n\n")}`,
													timestamp: Date.now(),
												},
											],
										};
										await writeConversation(updated);
									} else {
										await writeConversation({
											...freshConv,
											flowStatus: "completed",
											updatedAt: new Date().toISOString(),
										});
									}
								}
							}),
						)
						.catch((err: unknown) => {
							console.error(
								`[Chat] Flow execution ${execution.id} failed:`,
								(err as Error).message,
							);
							return withConversationLock(conversation.id, async () => {
								const freshConv = await readConversation(conversation.id);
								if (freshConv) {
									await writeConversation({
										...freshConv,
										flowStatus: "failed",
										updatedAt: new Date().toISOString(),
									});
								}
							});
						});

					return;
				}
				// Flow template not found — fall through to single CLI
				console.warn(
					`[Chat] Flow template ${intent.flowTemplateId} not found, falling back to CLI`,
				);
			}

			// Fallback: single CLI spawn (for CHAT category or missing template)
			const binary = getValidAgentBinary();
			const env = {
				...buildCleanEnv(),
				...getOAuthEnv(),
				TERM: "dumb",
			};

			const child = spawn(
				binary,
				[
					"-p",
					prompt,
					"--output-format",
					"text",
					"--no-session-persistence",
					"--model",
					cliModel,
					"--allowedTools",
					"Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch",
					"--max-turns",
					"3",
				],
				{
					env,
					cwd: process.env.WORKSPACE || "/workspace",
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			activeChatProcesses.set(chatId, child);

			// Send 202 immediately after spawn, before attaching event listeners,
			// to prevent a race where the child exits before the response is sent.
			res.status(202).json({
				chatId,
				conversationId: conversation.id,
				status: "streaming",
			});

			let fullResponse = "";

			child.stdout.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				fullResponse += text;
				broadcast({
					type: "chat:response:chunk",
					data: { chatId, chunk: text },
				});
			});

			child.stderr.on("data", (chunk: Buffer) => {
				console.warn(
					`[Chat] stderr for ${chatId}: ${chunk.toString().slice(0, 200)}`,
				);
			});

			child.on("error", (err) => {
				console.error(`[Chat] spawn error for ${chatId}:`, err.message);
				activeChatProcesses.delete(chatId);
				broadcast({
					type: "chat:response:complete",
					data: {
						chatId,
						fullResponse: "",
						exitCode: 1,
						error: `Process error: ${err.message}`,
						conversationId: conversation.id,
					},
				});
			});

			const timeout = setTimeout(() => {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 5000);
			}, 300000);

			child.on("close", async (code) => {
				clearTimeout(timeout);
				activeChatProcesses.delete(chatId);

				if (fullResponse.trim()) {
					try {
						await withConversationLock(conversation.id, async () => {
							const freshConv = await readConversation(conversation.id);
							if (freshConv) {
								const updated: ChatConversation = {
									...freshConv,
									updatedAt: new Date().toISOString(),
									messages: [
										...freshConv.messages,
										{
											id: randomUUID(),
											role: "assistant",
											content: fullResponse,
											timestamp: Date.now(),
										},
									],
								};
								await writeConversation(updated);
							}
						});
					} catch (err) {
						console.error(
							`[Chat] Failed to save conversation ${conversation.id}:`,
							(err as Error).message,
						);
					}
				}

				broadcast({
					type: "chat:response:complete",
					data: {
						chatId,
						fullResponse,
						exitCode: code,
						conversationId: conversation.id,
					},
				});
			});
		} catch (err) {
			console.error("[Chat] Agent mode error:", (err as Error).message);
			// Guard against double-response if headers already sent
			if (!res.headersSent) {
				res.status(500).json({
					error: "Failed to process agent request",
				});
			}
		}
	})();
}
