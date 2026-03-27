import { assertNotPrivateURL } from "./url-security.js";
import type { AnthropicToolDefinition } from "../types/chat.types.js";

// Maximum bytes to buffer from a fetched page (1 MB)
const MAX_FETCH_BYTES = 1_048_576;
// Maximum characters returned in tool result
const MAX_RESULT_CHARS = 8000;

// Tools available in chat mode
export const chatTools: AnthropicToolDefinition[] = [
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

export const systemPrompt =
	'You are Claude Haiku 4.5, a fast and helpful assistant inside Codeck, a cloud sandbox for coding. You have two tools: web_search (search the web) and web_fetch (read a specific URL). Use web_search proactively when the user asks about recent events, facts, or anything you are uncertain about. After searching, use web_fetch to read full articles or documentation for detailed answers. If the user asks you to modify files, write code to disk, run tests, deploy, or perform any action that requires filesystem or terminal access, tell them: "Switch to Agent mode using the toggle below to enable file access and code execution." Be concise, direct, and helpful. Answer in the same language the user writes in.';

/**
 * Read a response body with a byte cap to prevent OOM.
 * Aborts the fetch if content exceeds maxBytes.
 */
async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<string> {
	// Fast path: check content-length header
	const contentLength = response.headers.get("content-length");
	if (contentLength && parseInt(contentLength, 10) > maxBytes) {
		// Consume and discard the body to free the connection
		await response.body?.cancel();
		throw new Error(
			`Response too large (${contentLength} bytes, max ${maxBytes})`,
		);
	}

	const reader = response.body?.getReader();
	if (!reader) {
		return "";
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const decoder = new TextDecoder();
	return (
		chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
		decoder.decode()
	);
}

export async function executeTool(
	toolName: string,
	input: Record<string, unknown>,
): Promise<string> {
	if (toolName === "web_search" && input?.query) {
		try {
			const searchRes = await fetch(
				`https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(input.query))}`,
				{
					headers: {
						"User-Agent": "Codeck/1.0",
					},
					signal: AbortSignal.timeout(10000),
				},
			);
			const html = await readBodyCapped(searchRes, MAX_FETCH_BYTES);
			// Extract titles, URLs, and snippets from DDG HTML results
			const titles =
				html
					.match(/<a class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs)
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
			return combined || "No results found for this query.";
		} catch (e) {
			return `Search failed: ${(e as Error).message}`;
		}
	}

	if (toolName === "web_fetch" && input?.url) {
		try {
			const urlStr = String(input.url);
			// Validate protocol and block private/internal IPs (SSRF protection)
			const parsed = new URL(urlStr);
			if (!["http:", "https:"].includes(parsed.protocol)) {
				return "Only HTTP/HTTPS URLs are supported.";
			}
			await assertNotPrivateURL(urlStr);
			// Use redirect: "manual" to prevent SSRF bypass via
			// redirect to private/internal IPs. Validate each hop.
			const MAX_REDIRECTS = 3;
			let currentUrl = urlStr;
			let fetchRes: Response | null = null;
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				fetchRes = await fetch(currentUrl, {
					headers: {
						"User-Agent": "Codeck/1.0 (Web Fetch)",
						Accept: "text/html,text/plain,application/json",
					},
					signal: AbortSignal.timeout(15000),
					redirect: "manual",
				});
				if (fetchRes.status >= 300 && fetchRes.status < 400) {
					const location = fetchRes.headers.get("location");
					if (!location) break;
					const nextUrl = new URL(location, currentUrl).href;
					await assertNotPrivateURL(nextUrl);
					currentUrl = nextUrl;
					continue;
				}
				break;
			}
			if (!fetchRes) {
				return "Fetch failed: no response received";
			}
			if (!fetchRes.ok) {
				return `HTTP ${fetchRes.status}: ${fetchRes.statusText}`;
			}
			const contentType = fetchRes.headers.get("content-type") || "";
			const body = await readBodyCapped(fetchRes, MAX_FETCH_BYTES);
			if (contentType.includes("text/html")) {
				// Strip HTML tags, scripts, styles — extract text content
				const text = body
					.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
					.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]*>/g, " ")
					.replace(/\s+/g, " ")
					.trim();
				return text.slice(0, MAX_RESULT_CHARS);
			}
			return body.slice(0, MAX_RESULT_CHARS);
		} catch (e) {
			return `Fetch failed: ${(e as Error).message}`;
		}
	}

	return `Tool ${toolName} is not available.`;
}
