import { Router } from "express";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
	existsSync,
} from "fs";
import { join } from "path";
import { broadcast } from "../web/logger.js";
import {
	buildCleanEnv,
	getOAuthEnv,
	getValidAgentBinary,
} from "../services/claude-env.js";
import { classifyIntent } from "../services/intent-classifier.js";
import { getFlow, saveExecution } from "../services/flows.js";
import { runFlow, cancelExecution } from "../services/flow-runner.js";
import type { FlowExecution } from "../types/flow.types.js";

const router = Router();

// --- Conversation persistence ---

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

interface ChatConversation {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messages: ChatMessage[];
	flowExecutionId?: string;
	flowStatus?: string;
}

const CONVERSATIONS_DIR = "/workspace/.codeck/chat/conversations";

function ensureConversationsDir(): void {
	mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

function conversationPath(id: string): string {
	// Sanitize id to prevent path traversal
	const safeId = id.replace(/[^a-zA-Z0-9\-]/g, "");
	return join(CONVERSATIONS_DIR, `${safeId}.json`);
}

function readConversation(id: string): ChatConversation | null {
	const filePath = conversationPath(id);
	if (!existsSync(filePath)) return null;
	try {
		const data = readFileSync(filePath, "utf-8");
		return JSON.parse(data) as ChatConversation;
	} catch {
		return null;
	}
}

function writeConversation(conversation: ChatConversation): void {
	ensureConversationsDir();
	const filePath = conversationPath(conversation.id);
	writeFileSync(filePath, JSON.stringify(conversation, null, 2), {
		mode: 0o600,
	});
}

function autoName(message: string): string {
	return message.slice(0, 50).replace(/\n/g, " ").trim() || "Untitled";
}

function listAllConversations(): Array<{
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}> {
	ensureConversationsDir();
	const files = readdirSync(CONVERSATIONS_DIR).filter((f) =>
		f.endsWith(".json"),
	);
	const conversations = files
		.map((f) => {
			try {
				const data = readFileSync(join(CONVERSATIONS_DIR, f), "utf-8");
				const conv = JSON.parse(data) as ChatConversation;
				return {
					id: conv.id,
					name: conv.name,
					createdAt: conv.createdAt,
					updatedAt: conv.updatedAt,
					messageCount: conv.messages.length,
				};
			} catch {
				return null;
			}
		})
		.filter((c): c is NonNullable<typeof c> => c !== null);
	// Sort newest first
	conversations.sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
	return conversations;
}

// Active chat processes (for cancellation)
const activeChatProcesses = new Map<string, ChildProcess>();

// POST /api/chat/message — Send a message and get streaming response
// Returns immediately with chatId, streams response via WS events:
//   chat:response:chunk { chatId, chunk }
//   chat:response:complete { chatId, fullResponse }
// Accepts optional conversationId to append to an existing conversation
router.post("/message", (req, res) => {
	const { message, context, conversationId, model, useTools } = req.body;
	if (!message || typeof message !== "string") {
		res.status(400).json({ error: "message (string) is required" });
		return;
	}
	if (message.length > 50000) {
		res.status(400).json({ error: "Message too long (max 50,000 chars)" });
		return;
	}

	// Ensure conversations directory exists before any file operations.
	// On first use after a fresh install the directory may not exist yet,
	// and readConversation / writeConversation both depend on it.
	ensureConversationsDir();

	// Validate context if provided
	const safeContext =
		typeof context === "string" && context.length <= 50000 ? context : "";

	const chatId = randomUUID();
	const now = new Date().toISOString();

	// Resolve or create conversation
	let conversation: ChatConversation;
	if (conversationId && typeof conversationId === "string") {
		const existing = readConversation(conversationId);
		if (!existing) {
			res.status(404).json({ error: "Conversation not found" });
			return;
		}
		conversation = existing;
	} else {
		conversation = {
			id: randomUUID(),
			name: autoName(message),
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
	}

	// Append user message to conversation
	const userMessage: ChatMessage = {
		id: randomUUID(),
		role: "user",
		content: message,
		timestamp: Date.now(),
	};
	conversation.messages.push(userMessage);
	conversation.updatedAt = now;
	writeConversation(conversation);

	// Build prompt with conversation history for continuity
	let prompt = "";
	// Include previous messages as context (up to 10 most recent for speed)
	const prevMessages = conversation.messages.slice(-11, -1); // exclude the message we just added
	if (prevMessages.length > 0) {
		prompt += "Previous conversation:\n";
		for (const msg of prevMessages) {
			const label = msg.role === "user" ? "User" : "Assistant";
			prompt += `${label}: ${msg.content}\n\n`;
		}
		prompt += "---\n\n";
	}
	if (safeContext) {
		prompt += `${safeContext}\n\n`;
	}
	prompt += `User: ${message}`;

	// Validate model (default to haiku for fast chat)
	// Chat mode uses Haiku 4.5 (fast, available via OAuth token)
	const chatModel = "claude-haiku-4-5-20251001";

	// ── API Direct mode (with web search tool) ──
	if (!useTools) {
		// Build messages array for the API
		const apiMessages: Array<{ role: string; content: any }> =
			conversation.messages.slice(-11).map((m: ChatMessage) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			}));

		const oauthToken = getOAuthEnv().CLAUDE_CODE_OAUTH_TOKEN;
		if (!oauthToken) {
			res.status(401).json({ error: "Not authenticated" });
			return;
		}

		res.status(202).json({
			chatId,
			conversationId: conversation.id,
			status: "streaming",
		});

		// Tools available in chat mode
		const chatTools = [
			{
				name: "web_search",
				description:
					"Search the web for current information. Use when the user asks about recent events, needs facts you're unsure about, or asks you to look something up. Returns search result snippets.",
				input_schema: {
					type: "object" as const,
					properties: {
						query: {
							type: "string",
							description: "The search query",
						},
					},
					required: ["query"],
				},
			},
			{
				name: "web_fetch",
				description:
					"Fetch the content of a specific URL. Use after web_search to read full articles, documentation pages, or any webpage the user asks about. Returns the text content of the page.",
				input_schema: {
					type: "object" as const,
					properties: {
						url: {
							type: "string",
							description: "The URL to fetch",
						},
					},
					required: ["url"],
				},
			},
		];

		const systemPrompt =
			'You are Claude Haiku 4.5, a fast and helpful assistant inside Codeck, a cloud sandbox for coding. You have two tools: web_search (search the web) and web_fetch (read a specific URL). Use web_search proactively when the user asks about recent events, facts, or anything you are uncertain about. After searching, use web_fetch to read full articles or documentation for detailed answers. If the user asks you to modify files, write code to disk, run tests, deploy, or perform any action that requires filesystem or terminal access, tell them: "Switch to Agent mode using the toggle below to enable file access and code execution." Be concise, direct, and helpful. Answer in the same language the user writes in.';

		// Agentic loop: call API, handle tool_use, send results back
		(async () => {
			let fullResponse = "";
			let loopMessages = [...apiMessages];
			const MAX_TOOL_ROUNDS = 5;

			try {
				for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
					const useStream = true;
					const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-api-key": oauthToken,
							"anthropic-version": "2023-06-01",
						},
						body: JSON.stringify({
							model: chatModel,
							max_tokens: 4096,
							stream: useStream,
							system: systemPrompt,
							tools: chatTools,
							messages: loopMessages,
						}),
						signal: AbortSignal.timeout(120000),
					});

					if (!apiRes.ok || !apiRes.body) {
						let errDetail = `HTTP ${apiRes.status}`;
						try {
							const errBody = await apiRes.text();
							const errJson = JSON.parse(errBody);
							errDetail = errJson?.error?.message || errBody.slice(0, 200);
						} catch {
							/* use status code */
						}
						console.error(`[Chat] API error for ${chatId}: ${errDetail}`);
						broadcast({
							type: "chat:response:complete",
							data: {
								chatId,
								fullResponse: "",
								exitCode: 1,
								error: errDetail,
								conversationId: conversation.id,
							},
						});
						return;
					}

					// Parse SSE stream — collect text and tool_use blocks
					const reader = apiRes.body.getReader();
					const decoder = new TextDecoder();
					let sseBuffer = "";
					let roundText = "";
					const toolUseBlocks: Array<{
						id: string;
						name: string;
						input: any;
					}> = [];
					let currentToolId = "";
					let currentToolName = "";
					let currentToolInput = "";

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						sseBuffer += decoder.decode(value, { stream: true });
						const lines = sseBuffer.split("\n");
						sseBuffer = lines.pop() || "";

						for (const line of lines) {
							if (!line.startsWith("data: ")) continue;
							const jsonStr = line.slice(6);
							if (jsonStr === "[DONE]") continue;

							try {
								const event = JSON.parse(jsonStr);
								if (
									event.type === "content_block_delta" &&
									event.delta?.type === "text_delta" &&
									event.delta?.text
								) {
									roundText += event.delta.text;
									fullResponse += event.delta.text;
									broadcast({
										type: "chat:response:chunk",
										data: {
											chatId,
											chunk: event.delta.text,
										},
									});
								} else if (
									event.type === "content_block_start" &&
									event.content_block?.type === "tool_use"
								) {
									currentToolId = event.content_block.id || "";
									currentToolName = event.content_block.name || "";
									currentToolInput = "";
								} else if (
									event.type === "content_block_delta" &&
									event.delta?.type === "input_json_delta" &&
									event.delta?.partial_json
								) {
									currentToolInput += event.delta.partial_json;
								} else if (
									event.type === "content_block_stop" &&
									currentToolId
								) {
									let parsedInput = {};
									try {
										parsedInput = JSON.parse(currentToolInput);
									} catch {
										/* best effort */
									}
									toolUseBlocks.push({
										id: currentToolId,
										name: currentToolName,
										input: parsedInput,
									});
									currentToolId = "";
									currentToolName = "";
									currentToolInput = "";
								}
							} catch {
								/* skip unparseable */
							}
						}
					}

					// If no tool_use, we're done
					if (toolUseBlocks.length === 0) break;

					// Execute tools and prepare tool_result messages
					const assistantContent: any[] = [];
					if (roundText)
						assistantContent.push({
							type: "text",
							text: roundText,
						});
					for (const tu of toolUseBlocks) {
						assistantContent.push({
							type: "tool_use",
							id: tu.id,
							name: tu.name,
							input: tu.input,
						});
					}

					loopMessages.push({
						role: "assistant",
						content: assistantContent,
					});

					const toolResults: any[] = [];
					for (const tu of toolUseBlocks) {
						let result = "";
						if (tu.name === "web_search" && tu.input?.query) {
							try {
								broadcast({
									type: "chat:response:chunk",
									data: {
										chatId,
										chunk: `\n\n🔍 Searching: ${tu.input.query}...\n\n`,
									},
								});
								fullResponse += `\n\n🔍 Searching: ${tu.input.query}...\n\n`;
								const searchRes = await fetch(
									`https://html.duckduckgo.com/html/?q=${encodeURIComponent(tu.input.query)}`,
									{
										headers: {
											"User-Agent": "Codeck/1.0",
										},
										signal: AbortSignal.timeout(10000),
									},
								);
								const html = await searchRes.text();
								// Extract titles, URLs, and snippets from DDG HTML results
								const titles =
									html
										.match(
											/<a class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs,
										)
										?.map((s) => {
											const hrefMatch = s.match(/href="([^"]*)"/);
											const textMatch = s.match(/>([^<]*)<\/a>/);
											return `${textMatch?.[1]?.trim() || ""}: ${hrefMatch?.[1] || ""}`;
										})
										.slice(0, 8) || [];
								const snippets =
									html
										.match(/<a class="result__snippet"[^>]*>(.*?)<\/a>/gs)
										?.map((s) => s.replace(/<[^>]*>/g, "").trim())
										.slice(0, 8) || [];
								const combined = titles
									.map((t, i) => `${t}\n${snippets[i] || ""}`)
									.join("\n\n");
								result = combined || "No results found for this query.";
							} catch (e) {
								result = `Search failed: ${(e as Error).message}`;
							}
						} else if (tu.name === "web_fetch" && tu.input?.url) {
							try {
								const urlStr = String(tu.input.url);
								// Basic URL validation
								const parsed = new URL(urlStr);
								if (!["http:", "https:"].includes(parsed.protocol)) {
									result = "Only HTTP/HTTPS URLs are supported.";
								} else {
									broadcast({
										type: "chat:response:chunk",
										data: {
											chatId,
											chunk: `\n\n📄 Reading: ${urlStr.slice(0, 80)}...\n\n`,
										},
									});
									fullResponse += `\n\n📄 Reading: ${urlStr.slice(0, 80)}...\n\n`;
									const fetchRes = await fetch(urlStr, {
										headers: {
											"User-Agent": "Codeck/1.0 (Web Fetch)",
											Accept: "text/html,text/plain,application/json",
										},
										signal: AbortSignal.timeout(15000),
										redirect: "follow",
									});
									if (!fetchRes.ok) {
										result = `HTTP ${fetchRes.status}: ${fetchRes.statusText}`;
									} else {
										const contentType =
											fetchRes.headers.get("content-type") || "";
										const body = await fetchRes.text();
										if (contentType.includes("text/html")) {
											// Strip HTML tags, scripts, styles — extract text content
											const text = body
												.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
												.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
												.replace(/<[^>]*>/g, " ")
												.replace(/\s+/g, " ")
												.trim();
											result = text.slice(0, 8000);
										} else {
											result = body.slice(0, 8000);
										}
									}
								}
							} catch (e) {
								result = `Fetch failed: ${(e as Error).message}`;
							}
						} else {
							result = `Tool ${tu.name} is not available.`;
						}
						toolResults.push({
							type: "tool_result",
							tool_use_id: tu.id,
							content: result,
						});
					}

					loopMessages.push({
						role: "user",
						content: toolResults,
					});

					// Continue the loop — next round will process tool results
				}

				// Save to conversation
				const freshConv = readConversation(conversation.id);
				if (freshConv && fullResponse.trim()) {
					freshConv.messages.push({
						id: randomUUID(),
						role: "assistant",
						content: fullResponse,
						timestamp: Date.now(),
					});
					freshConv.updatedAt = new Date().toISOString();
					writeConversation(freshConv);
				}

				broadcast({
					type: "chat:response:complete",
					data: {
						chatId,
						fullResponse,
						exitCode: 0,
						conversationId: conversation.id,
					},
				});
			} catch (err) {
				const errMsg = (err as Error).message || "Unknown error";
				console.error(`[Chat] API error for ${chatId}:`, errMsg);
				broadcast({
					type: "chat:response:complete",
					data: {
						chatId,
						fullResponse: "",
						exitCode: 1,
						error: errMsg,
						conversationId: conversation.id,
					},
				});
			}
		})();

		return;
	}

	// ── Agent mode — classify intent and route to flow or CLI ──
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

					// Link flow to conversation
					conversation.flowExecutionId = execution.id;
					conversation.flowStatus = "running";
					writeConversation(conversation);

					// Build ordered agent list by walking the graph from entryAgentId
					const agentList: Array<{ id: string; name: string; role: string }> =
						[];
					{
						const visited = new Set<string>();
						let cursor: string | undefined = flow.entryAgentId;
						while (cursor && !visited.has(cursor)) {
							const def = flow.agents[cursor] as
								| import("../types/flow.types.js").AgentDefinition
								| undefined;
							if (!def) break;
							agentList.push({ id: def.id, name: def.name, role: def.role });
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
						.then(() => {
							const freshConv = readConversation(conversation.id);
							if (freshConv) {
								const finalExec = { ...execution };
								const outputs = Object.values(finalExec.agentResults)
									.filter((r) => r.output)
									.map((r) => `**${r.agentId}**:\n${r.output.slice(0, 2000)}`);
								if (outputs.length > 0) {
									freshConv.messages.push({
										id: randomUUID(),
										role: "assistant",
										content: `Flow "${flow.name}" completed.\n\n${outputs.join("\n\n---\n\n")}`,
										timestamp: Date.now(),
									});
								}
								freshConv.flowStatus = "completed";
								freshConv.updatedAt = new Date().toISOString();
								writeConversation(freshConv);
							}
						})
						.catch((err: unknown) => {
							console.error(
								`[Chat] Flow execution ${execution.id} failed:`,
								(err as Error).message,
							);
							const freshConv = readConversation(conversation.id);
							if (freshConv) {
								freshConv.flowStatus = "failed";
								freshConv.updatedAt = new Date().toISOString();
								writeConversation(freshConv);
							}
						});

					return;
				}
				// Flow template not found — fall through to single CLI
				console.warn(
					`[Chat] Flow template ${intent.flowTemplateId} not found, falling back to CLI`,
				);
			}

			// Fallback: single CLI spawn (for CHAT category or missing template)
			const cliModel = model || "haiku";
			const binary = getValidAgentBinary();
			const env = { ...buildCleanEnv(), ...getOAuthEnv(), TERM: "dumb" };

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

			child.on("close", (code) => {
				clearTimeout(timeout);
				activeChatProcesses.delete(chatId);

				if (fullResponse.trim()) {
					const freshConv = readConversation(conversation.id);
					if (freshConv) {
						freshConv.messages.push({
							id: randomUUID(),
							role: "assistant",
							content: fullResponse,
							timestamp: Date.now(),
						});
						freshConv.updatedAt = new Date().toISOString();
						writeConversation(freshConv);
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

			res.status(202).json({
				chatId,
				conversationId: conversation.id,
				status: "streaming",
			});
		} catch (err) {
			console.error("[Chat] Agent mode error:", (err as Error).message);
			res.status(500).json({ error: "Failed to process agent request" });
		}
	})();
});

// POST /api/chat/cancel — Cancel an active chat or flow execution
router.post("/cancel", (req, res) => {
	const { chatId, executionId } = req.body;

	// Cancel a flow execution
	if (executionId && typeof executionId === "string") {
		cancelExecution(executionId);
		res.json({ success: true });
		return;
	}

	const proc = activeChatProcesses.get(chatId);
	if (!proc) {
		res.status(404).json({ error: "Chat not found or already completed" });
		return;
	}
	proc.kill("SIGTERM");
	setTimeout(() => {
		if (!proc.killed) proc.kill("SIGKILL");
	}, 3000);
	activeChatProcesses.delete(chatId);
	res.json({ success: true });
});

// --- Conversation CRUD endpoints ---

// GET /api/chat/conversations — List all conversations (newest first, no messages)
router.get("/conversations", (_req, res) => {
	try {
		const conversations = listAllConversations();
		res.json({ conversations });
	} catch (err) {
		console.error("[Chat] Failed to list conversations:", err);
		res.status(500).json({ error: "Failed to list conversations" });
	}
});

// GET /api/chat/conversations/:id — Get a conversation with all messages
router.get("/conversations/:id", (req, res) => {
	const { id } = req.params;
	const conversation = readConversation(id);
	if (!conversation) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	res.json(conversation);
});

// POST /api/chat/conversations — Create a new empty conversation
router.post("/conversations", (req, res) => {
	const { name } = req.body;
	const now = new Date().toISOString();
	const conversation: ChatConversation = {
		id: randomUUID(),
		name:
			typeof name === "string" && name.trim()
				? name.trim().slice(0, 200)
				: "New conversation",
		createdAt: now,
		updatedAt: now,
		messages: [],
	};
	try {
		writeConversation(conversation);
		res.status(201).json({ id: conversation.id, name: conversation.name });
	} catch (err) {
		console.error("[Chat] Failed to create conversation:", err);
		res.status(500).json({ error: "Failed to create conversation" });
	}
});

// PUT /api/chat/conversations/:id/name — Rename a conversation
router.put("/conversations/:id/name", (req, res) => {
	const { id } = req.params;
	const { name } = req.body;
	if (!name || typeof name !== "string" || !name.trim()) {
		res.status(400).json({ error: "name (non-empty string) is required" });
		return;
	}
	const conversation = readConversation(id);
	if (!conversation) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	conversation.name = name.trim().slice(0, 200);
	conversation.updatedAt = new Date().toISOString();
	try {
		writeConversation(conversation);
		res.json({ id: conversation.id, name: conversation.name });
	} catch (err) {
		console.error("[Chat] Failed to rename conversation:", err);
		res.status(500).json({ error: "Failed to rename conversation" });
	}
});

// DELETE /api/chat/conversations/:id — Delete a conversation
router.delete("/conversations/:id", (req, res) => {
	const { id } = req.params;
	const filePath = conversationPath(id);
	if (!existsSync(filePath)) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	try {
		unlinkSync(filePath);
		res.json({ success: true });
	} catch (err) {
		console.error("[Chat] Failed to delete conversation:", err);
		res.status(500).json({ error: "Failed to delete conversation" });
	}
});

export default router;
