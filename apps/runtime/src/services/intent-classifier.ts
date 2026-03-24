/**
 * Intent Classifier — Routes chat messages to the appropriate flow template.
 *
 * Two-tier approach:
 * 1. Keyword fast-path (0ms, no API call) for obvious patterns
 * 2. Haiku API fallback (~500ms) for ambiguous messages
 */

import { getOAuthEnv } from "./claude-env.js";

// ── Types ──

export type IntentCategory =
	| "CHAT"
	| "CODE_TASK"
	| "BUG_FIX"
	| "NEW_PROJECT"
	| "FEATURE";

export interface IntentClassification {
	category: IntentCategory;
	confidence: "high" | "medium";
	flowTemplateId: string | null;
}

// ── Flow template mapping ──

const FLOW_MAP: Readonly<Record<IntentCategory, string | null>> = Object.freeze(
	{
		CHAT: null,
		CODE_TASK: "00000000-0000-0000-0000-000000000001", // Code Review
		BUG_FIX: "00000000-0000-0000-0000-000000000002", // TDD Cycle
		NEW_PROJECT: "tpl-interviewer-to-build", // Prompt to Production
		FEATURE: "tpl-fullstack-builder", // Fullstack Builder
	},
);

// ── Keyword patterns (Tier 1) ──

interface PatternRule {
	pattern: RegExp;
	category: IntentCategory;
}

const KEYWORD_RULES: readonly PatternRule[] = Object.freeze([
	// BUG_FIX — error/fix signals (checked BEFORE NEW_PROJECT to avoid
	// "build me a fix" matching NEW_PROJECT due to "build me")
	{
		pattern:
			/\b(fix\s+(this|the|a)|bug|not\s+working|broken|crash(es|ing)?|error|fails?|failing|arregla|no\s+funciona|no\s+anda|se\s+rompe|está\s+roto)\b/i,
		category: "BUG_FIX",
	},

	// CHAT — Q&A / explanations
	{
		pattern:
			/\b(explain|what\s+is|how\s+does|tell\s+me\s+about|why\s+does|can\s+you\s+explain|qué\s+es|cómo\s+funciona|explica(me)?|para\s+qué\s+sirve)\b/i,
		category: "CHAT",
	},
	{
		pattern:
			/\b(what\s+are|difference\s+between|compare|pros\s+and\s+cons|recommend|suggest|opinion|help\s+me\s+understand)\b/i,
		category: "CHAT",
	},

	// NEW_PROJECT — strong signals (after BUG_FIX so mixed signals route correctly)
	{
		pattern:
			/\b(build\s+me|create\s+(a\s+)?(new\s+)?|new\s+project|start\s+(a\s+)?new|quiero\s+(crear|hacer|armar|construir)|hazme|crea(me)?\s+(un|una)|construi(r|me)|armame)\b/i,
		category: "NEW_PROJECT",
	},
	{
		pattern:
			/\b(from\s+scratch|desde\s+cero|proyecto\s+nuevo|landing\s+page|web\s+app|mobile\s+app|api\s+server)\b/i,
		category: "NEW_PROJECT",
	},

	// FEATURE — multi-file implementation signals
	{
		pattern:
			/\b(add\s+(a\s+)?(new\s+)?feature|implement|integrat(e|ion)|refactor|migration|agrega(r|me)?|añade|implementa|migra(r|ción))\b/i,
		category: "FEATURE",
	},

	// CODE_TASK — single code changes
	{
		pattern:
			/\b(change|modify|update|edit|rename|move|make\s+(the|it|this)|cambia|modifica|actualiza|renombra)\b/i,
		category: "CODE_TASK",
	},
]);

// ── Tier 1: Keyword fast-path ──

function keywordClassify(message: string): IntentClassification | null {
	const text = message.toLowerCase().trim();

	// Very short messages (< 15 chars) are almost always chat
	if (text.length < 15 && !/\b(fix|bug|crea|build|arma|haz)\b/i.test(text)) {
		return { category: "CHAT", confidence: "high", flowTemplateId: null };
	}

	for (const rule of KEYWORD_RULES) {
		if (rule.pattern.test(text)) {
			return {
				category: rule.category,
				confidence: "high",
				flowTemplateId: FLOW_MAP[rule.category],
			};
		}
	}

	return null; // No match — fall through to Haiku
}

// ── Tier 2: Haiku API classification ──

async function haikuClassify(message: string): Promise<IntentClassification> {
	const systemPrompt = `You classify user messages for a coding assistant. Respond with ONLY one word — the category.

Categories:
- CHAT: Questions, explanations, learning, opinions, recommendations, general conversation
- CODE_TASK: Simple code changes — modify a file, fix styling, rename, small edits (1-2 files)
- BUG_FIX: Something is broken, errors, crashes, tests failing, debugging
- NEW_PROJECT: Build something from scratch — new app, new website, new API, new project
- FEATURE: Add significant functionality — new endpoints, new components, integrations, multi-file changes

Respond with EXACTLY one word: CHAT, CODE_TASK, BUG_FIX, NEW_PROJECT, or FEATURE`;

	try {
		const oauthToken = getOAuthEnv().CLAUDE_CODE_OAUTH_TOKEN;
		if (!oauthToken) {
			// No token — default to CHAT
			return { category: "CHAT", confidence: "medium", flowTemplateId: null };
		}

		// CLAUDE_CODE_OAUTH_TOKEN doubles as x-api-key for the Anthropic Messages API
		// (OAuth access tokens from Claude Code CLI are accepted as API keys)
		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": oauthToken,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 10,
				system: systemPrompt,
				messages: [{ role: "user", content: message }],
			}),
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) {
			return { category: "CHAT", confidence: "medium", flowTemplateId: null };
		}

		const data = await res.json();
		const rawText = data?.content?.[0]?.text;
		const text =
			typeof rawText === "string" ? rawText.trim().toUpperCase() : "CHAT";

		const validCategories: IntentCategory[] = [
			"CHAT",
			"CODE_TASK",
			"BUG_FIX",
			"NEW_PROJECT",
			"FEATURE",
		];
		const category = validCategories.includes(text as IntentCategory)
			? (text as IntentCategory)
			: "CHAT";

		return {
			category,
			confidence: "medium",
			flowTemplateId: FLOW_MAP[category],
		};
	} catch (err) {
		console.warn("[IntentClassifier] Haiku call failed:", err);
		return { category: "CHAT", confidence: "medium", flowTemplateId: null };
	}
}

// ── Public API ──

export async function classifyIntent(
	message: string,
): Promise<IntentClassification> {
	// Tier 1: keyword fast-path
	const keywordResult = keywordClassify(message);
	if (keywordResult) return keywordResult;

	// Tier 2: Haiku API classification
	return haikuClassify(message);
}

// Export for testing
export { keywordClassify, haikuClassify, FLOW_MAP };
