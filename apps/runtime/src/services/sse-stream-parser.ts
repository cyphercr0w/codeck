/**
 * SSE stream parser for the Anthropic Messages API.
 *
 * Parses a streaming response into text chunks and tool_use blocks.
 * Emits text deltas via a callback for real-time streaming to clients.
 */

import type { ParsedToolUseBlock } from "../types/chat.types.js";

export interface SSEParserCallbacks {
	onTextDelta: (text: string) => void;
}

export interface SSEParseResult {
	text: string;
	toolUseBlocks: ParsedToolUseBlock[];
}

export async function parseSSEStream(
	body: ReadableStream<Uint8Array>,
	callbacks: SSEParserCallbacks,
): Promise<SSEParseResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let sseBuffer = "";
	let roundText = "";
	const toolUseBlocks: ParsedToolUseBlock[] = [];

	// Explicit block type tracking (fixes fragile currentToolId guard)
	let currentBlockType: "text" | "tool_use" | null = null;
	let currentToolId = "";
	let currentToolName = "";
	let currentToolInput = "";

	try {
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

					if (event.type === "content_block_start") {
						const blockType = event.content_block?.type;
						currentBlockType = blockType === "tool_use" ? "tool_use" : "text";
						if (currentBlockType === "tool_use") {
							currentToolId = event.content_block.id || "";
							currentToolName = event.content_block.name || "";
							currentToolInput = "";
						}
					} else if (
						event.type === "content_block_delta" &&
						event.delta?.type === "text_delta" &&
						event.delta?.text
					) {
						roundText += event.delta.text;
						callbacks.onTextDelta(event.delta.text);
					} else if (
						event.type === "content_block_delta" &&
						event.delta?.type === "input_json_delta" &&
						event.delta?.partial_json
					) {
						currentToolInput += event.delta.partial_json;
					} else if (
						event.type === "content_block_stop" &&
						currentBlockType === "tool_use"
					) {
						let parsedInput: Record<string, unknown> = {};
						try {
							parsedInput = JSON.parse(currentToolInput);
						} catch {
							console.warn(
								`[SSE] Failed to parse tool input for ${currentToolName} (id: ${currentToolId}), using empty object`,
							);
						}
						toolUseBlocks.push({
							id: currentToolId,
							name: currentToolName,
							input: parsedInput,
						});
						currentBlockType = null;
						currentToolId = "";
						currentToolName = "";
						currentToolInput = "";
					} else if (event.type === "content_block_stop") {
						currentBlockType = null;
					}
				} catch {
					/* skip unparseable SSE lines */
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { text: roundText, toolUseBlocks };
}
