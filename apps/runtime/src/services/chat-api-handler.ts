/**
 * API Direct Mode handler — calls the Anthropic Messages API directly
 * with streaming, web_search/web_fetch tools, and an agentic tool loop.
 */

import { randomUUID } from "crypto";
import { broadcast } from "../web/logger.js";
import { getOAuthEnv } from "./claude-env.js";
import {
	readConversation,
	writeConversation,
	withConversationLock,
	MODEL_MAP,
} from "./conversation-storage.js";
import { chatTools, systemPrompt, executeTool } from "./web-tools.js";
import { parseSSEStream } from "./sse-stream-parser.js";
import type {
	ChatConversation,
	ChatMessage,
	AnthropicMessage,
	AnthropicContentBlock,
	AnthropicToolResultBlock,
} from "../types/chat.types.js";
import type { Response as ExpressResponse } from "express";

const MAX_TOOL_ROUNDS = 5;

export interface ApiDirectModeParams {
	chatId: string;
	conversation: ChatConversation;
	model: string;
	context?: string;
}

export function handleApiDirectMode(
	res: ExpressResponse,
	params: ApiDirectModeParams,
): void {
	const { chatId, conversation, model, context } = params;

	const oauthToken = getOAuthEnv().CLAUDE_CODE_OAUTH_TOKEN;
	if (!oauthToken) {
		res
			.status(401)
			.json({ error: "Not authenticated — please re-login in Terminal" });
		return;
	}

	const chatModel = MODEL_MAP[model] || MODEL_MAP.haiku;

	// Determine correct auth header: OAuth tokens use Bearer, API keys use x-api-key
	const isOAuthToken = oauthToken.startsWith("ey") || oauthToken.includes(".");
	const authHeaders: Record<string, string> = isOAuthToken
		? { Authorization: `Bearer ${oauthToken}` }
		: { "x-api-key": oauthToken };

	res.status(202).json({
		chatId,
		conversationId: conversation.id,
		status: "streaming",
	});

	// Build messages array for the API
	const apiMessages: AnthropicMessage[] = conversation.messages
		.slice(-11)
		.filter((m: ChatMessage) => m.role === "user" || m.role === "assistant")
		.map((m: ChatMessage) => ({
			role: m.role,
			content: m.content,
		}));

	(async () => {
		let fullResponse = "";
		let loopMessages: AnthropicMessage[] = [...apiMessages];

		try {
			for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
				const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...authHeaders,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify({
						model: chatModel,
						max_tokens: 4096,
						stream: true,
						system: context
							? `${systemPrompt}\n\n<user-context>${context}</user-context>`
							: systemPrompt,
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
						type: "chat:response:error",
						data: {
							chatId,
							error: errDetail,
							conversationId: conversation.id,
						},
					});
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

				// Parse SSE stream
				const { text: roundText, toolUseBlocks } = await parseSSEStream(
					apiRes.body,
					{
						onTextDelta(chunk) {
							fullResponse += chunk;
							broadcast({
								type: "chat:response:chunk",
								data: { chatId, chunk },
							});
						},
					},
				);

				// If no tool_use, we're done
				if (toolUseBlocks.length === 0) break;

				// Build assistant content blocks (immutable — no mutation of conversation)
				const assistantContent: AnthropicContentBlock[] = [];
				if (roundText) {
					assistantContent.push({ type: "text", text: roundText });
				}
				for (const tu of toolUseBlocks) {
					assistantContent.push({
						type: "tool_use",
						id: tu.id,
						name: tu.name,
						input: tu.input,
					});
				}

				loopMessages = [
					...loopMessages,
					{ role: "assistant", content: assistantContent },
				];

				// Execute tools and prepare tool_result messages
				const toolResults: AnthropicToolResultBlock[] = [];
				for (const tu of toolUseBlocks) {
					const statusEmoji =
						tu.name === "web_search" ? "🔍 Searching" : "📄 Reading";
					const statusLabel =
						tu.name === "web_search"
							? String(tu.input.query ?? "")
							: String(tu.input.url ?? "").slice(0, 80);
					const statusMsg = `\n\n${statusEmoji}: ${statusLabel}...\n\n`;
					fullResponse += statusMsg;
					broadcast({
						type: "chat:response:chunk",
						data: { chatId, chunk: statusMsg },
					});

					const result = await executeTool(tu.name, tu.input);
					toolResults.push({
						type: "tool_result",
						tool_use_id: tu.id,
						content: result,
					});
				}

				loopMessages = [
					...loopMessages,
					{ role: "user", content: toolResults },
				];
			}

			// Save to conversation (strip tool status messages from stored content)
			const cleanResponse = fullResponse
				.replace(/\n*🔍 Searching: [^\n]*\.\.\.\n*/g, "")
				.replace(/\n*📄 Reading: [^\n]*\.\.\.\n*/g, "")
				.trim();
			await withConversationLock(conversation.id, async () => {
				const freshConv = await readConversation(conversation.id);
				if (freshConv && cleanResponse) {
					const updated: ChatConversation = {
						...freshConv,
						updatedAt: new Date().toISOString(),
						messages: [
							...freshConv.messages,
							{
								id: randomUUID(),
								role: "assistant",
								content: cleanResponse,
								timestamp: Date.now(),
							},
						],
					};
					await writeConversation(updated);
				}
			});

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
				type: "chat:response:error",
				data: {
					chatId,
					error: errMsg,
					conversationId: conversation.id,
				},
			});
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
}
