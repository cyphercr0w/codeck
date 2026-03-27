/**
 * Chat subsystem types — shared across routes, handlers, and services.
 */

// ── Conversation persistence ──

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface ChatConversation {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messages: ChatMessage[];
}

export interface ConversationSummary {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

// ── Anthropic Messages API types ──

export interface AnthropicTextBlock {
	type: "text";
	text: string;
}

export interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
}

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[];
}

export interface AnthropicToolDefinition {
	name: string;
	description: string;
	input_schema: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
	};
}

// ── SSE stream event types ──

export interface ParsedToolUseBlock {
	id: string;
	name: string;
	input: Record<string, unknown>;
}
