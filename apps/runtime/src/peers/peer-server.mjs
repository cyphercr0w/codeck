#!/usr/bin/env node
/**
 * Codeck Peer MCP Server (Channel-based)
 *
 * MCP server loaded by each Claude Code agent session in a peer flow.
 * Uses the claude/channel protocol to push messages into the session —
 * channel messages trigger Claude to act (they are NOT passive context).
 *
 * Architecture:
 *   1. Connects to Claude Code over stdio (standard MCP transport)
 *   2. Registers with the Codeck broker (in-process HTTP API)
 *   3. Polls broker for messages every 1s → pushes via channel notification
 *   4. Exposes tools: list_peers, send_message, set_summary, check_messages, report_decision
 *
 * Environment variables:
 *   PEER_AGENT_ID     — Agent ID from the flow definition (e.g. "reviewer")
 *   PEER_EXECUTION_ID — Flow execution ID
 *   PEER_SESSION_ID   — PTY session ID (for frontend terminal attachment)
 *   BROKER_URL        — Broker base URL (default: http://localhost/api/peers)
 *
 * Reference: https://code.claude.com/docs/en/channels-reference
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BROKER = process.env.BROKER_URL || "http://localhost/api/peers";
const AGENT_ID = process.env.PEER_AGENT_ID || "unknown";
const EXECUTION_ID = process.env.PEER_EXECUTION_ID || "";
const SESSION_ID = process.env.PEER_SESSION_ID || "";
const ORCH_PEER_ID = `orch-${EXECUTION_ID}`;
const POLL_INTERVAL = 1000;
const HEARTBEAT_INTERVAL = 15000;

/** @type {string | null} */
let myPeerId = null;

// ── Logging ──

function log(msg) {
	console.error(`[codeck-peer:${AGENT_ID}] ${msg}`);
}

// ── HTTP helpers ──

/** @param {string} path @param {Record<string, unknown>} body */
async function brokerPost(path, body) {
	const res = await fetch(`${BROKER}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Broker ${path} returned ${res.status}: ${text}`);
	}
	const contentType = res.headers.get("content-type") || "";
	if (!contentType.includes("application/json")) {
		throw new Error(`Broker ${path} returned non-JSON content-type: ${contentType}`);
	}
	try {
		return await res.json();
	} catch (parseErr) {
		throw new Error(`Broker ${path} returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
	}
}

// ── MCP Server (using Server, not McpServer — required for channels) ──

const mcp = new Server(
	{ name: "codeck-peer", version: "0.2.0" },
	{
		capabilities: {
			experimental: { "claude/channel": {} },
			tools: {},
		},
		// Added to Claude's system prompt — tells Claude what to expect from this channel
		instructions: [
			`You are agent "${AGENT_ID}" in a multi-agent flow (execution: ${EXECUTION_ID}).`,
			"Messages from the orchestrator and other agents arrive as <channel source=\"codeck-peer\" ...> tags.",
			"When you receive a channel message, read it and act on it immediately.",
			"When you finish your task, use the report_decision tool to report your decision.",
			"Available tools: list_peers, send_message, set_summary, check_messages, report_decision.",
		].join(" "),
	},
);

// ── Tool definitions ──

/** @type {Array<{name: string, description: string, inputSchema: object}>} */
const tools = [
	{
		name: "list_peers",
		description: "List other active agent sessions in this flow execution",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "send_message",
		description: "Send a message to another agent in this flow execution",
		inputSchema: {
			type: "object",
			properties: {
				to_id: { type: "string", description: "Target peer ID" },
				message: { type: "string", description: "Message to send" },
				message_type: {
					type: "string",
					enum: ["prompt", "response", "decision", "route", "system"],
					description: "Message type (default: response)",
				},
			},
			required: ["to_id", "message"],
		},
	},
	{
		name: "set_summary",
		description: "Update what you are currently working on (visible to other peers)",
		inputSchema: {
			type: "object",
			properties: {
				summary: { type: "string", description: "Brief description of current work" },
			},
			required: ["summary"],
		},
	},
	{
		name: "check_messages",
		description: "Check for new messages from other peers or the orchestrator",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "report_decision",
		description: "Report a structured decision (e.g. APPROVE, REQUEST_CHANGES) to the orchestrator. Call this when you finish your task.",
		inputSchema: {
			type: "object",
			properties: {
				decision: {
					type: "string",
					description: "The decision keyword (e.g. APPROVE, REQUEST_CHANGES, LOOP, CLEAN)",
				},
				summary: {
					type: "string",
					description: "Brief explanation of the decision",
				},
			},
			required: ["decision"],
		},
	},
];

// Tool discovery — Claude queries this at startup
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// Tool execution
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
	const { name, arguments: args } = req.params;
	try {
		if (!myPeerId && name !== "list_peers") {
			return { content: [{ type: "text", text: "Error: Not registered with broker — peer messaging unavailable." }], isError: true };
		}

		switch (name) {
			case "list_peers": {
				const peers = await brokerPost("/list-peers", {
					executionId: EXECUTION_ID,
					excludePeerId: myPeerId,
				});
				if (!peers || peers.length === 0) {
					return { content: [{ type: "text", text: "No other peers connected." }] };
				}
				const list = peers
					.map((p) => `- ${p.peerId} [${p.role}] agent=${p.agentId} — ${p.summary || "no summary"}`)
					.join("\n");
				return { content: [{ type: "text", text: `Active peers:\n${list}` }] };
			}

			case "send_message": {
				await brokerPost("/send-message", {
					from: myPeerId,
					to: args.to_id,
					type: args.message_type || "response",
					payload: args.message,
					executionId: EXECUTION_ID,
				});
				return {
					content: [{ type: "text", text: `Message sent to ${args.to_id}.` }],
				};
			}

			case "set_summary": {
				await brokerPost("/set-summary", { peerId: myPeerId, summary: args.summary });
				return { content: [{ type: "text", text: `Summary updated: "${args.summary}"` }] };
			}

			case "check_messages": {
				const result = await brokerPost("/poll-messages", { peerId: myPeerId });
				if (!result.messages || result.messages.length === 0) {
					return { content: [{ type: "text", text: "No new messages." }] };
				}
				const msgs = result.messages
					.map((m) => `[From ${m.from} (${m.type || "message"})]: ${m.payload}`)
					.join("\n\n");
				return { content: [{ type: "text", text: `Messages received:\n\n${msgs}` }] };
			}

			case "report_decision": {
				const payload = args.summary
					? `DECISION: ${args.decision}\n${args.summary}`
					: `DECISION: ${args.decision}`;
				await brokerPost("/send-message", {
					from: myPeerId,
					to: ORCH_PEER_ID,
					type: "decision",
					payload,
					executionId: EXECUTION_ID,
				});
				return { content: [{ type: "text", text: `Decision reported: ${args.decision}` }] };
			}

			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	} catch (err) {
		return {
			content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
			isError: true,
		};
	}
});

// ── Background polling + channel push ──

async function pollAndPush() {
	if (!myPeerId) return;
	try {
		const result = await brokerPost("/poll-messages", { peerId: myPeerId });
		if (!result.messages || result.messages.length === 0) return;

		for (const msg of result.messages) {
			try {
				// Use server.notification() — the proper channel push method.
				// This sends a notifications/claude/channel event that Claude acts on.
				await mcp.notification({
					method: "notifications/claude/channel",
					params: {
						content: msg.payload,
						meta: {
							from_id: msg.from,
							message_type: msg.type,
							execution_id: msg.executionId,
						},
					},
				});
				log(`Pushed message from ${msg.from} via channel`);
			} catch (err) {
				// Channel push failure usually means stdio transport is broken —
				// re-queuing would create an infinite loop. Log and drop.
				log(`Channel push failed for message from ${msg.from}: ${err instanceof Error ? err.message : "unknown"}`);
			}
		}
	} catch (err) {
		log(`Broker poll failed: ${err instanceof Error ? err.message : "unknown"}`);
	}
}

// ── Lifecycle ──

async function register() {
	const MAX_RETRIES = 10;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const result = await brokerPost("/register", {
				agentId: AGENT_ID,
				executionId: EXECUTION_ID,
				role: AGENT_ID,
				summary: `${AGENT_ID} — initializing`,
				pid: process.pid,
				sessionId: SESSION_ID,
			});
			if (!result.peerId) throw new Error("No peerId in response");
			myPeerId = result.peerId;
			log(`Registered with broker as ${myPeerId} (pid ${process.pid})`);
			return;
		} catch (err) {
			log(`Registration attempt ${attempt}/${MAX_RETRIES} failed: ${err instanceof Error ? err.message : err}`);
			if (attempt === MAX_RETRIES) {
				log("Failed to register with broker — continuing without peer messaging");
				return;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

async function unregister() {
	if (myPeerId) {
		try {
			await brokerPost("/unregister", { peerId: myPeerId });
			log("Unregistered from broker");
		} catch {
			/* best effort */
		}
	}
}

/** @type {NodeJS.Timeout[]} */
const intervals = [];

function shutdown() {
	for (const id of intervals) clearInterval(id);
	intervals.length = 0;
	// Force exit after 3s if unregister hangs (broker may be unreachable)
	const forceTimer = setTimeout(() => {
		log("Shutdown timeout — forcing exit");
		process.exit(1);
	}, 3000);
	forceTimer.unref();
	unregister().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) => {
	log(`Unhandled rejection: ${err instanceof Error ? err.message : err}`);
});

// ── Start ──
// Order matters: connect FIRST so the channel is active, THEN register with broker.
// This ensures that when the orchestrator sends a message after seeing our registration,
// the channel is already connected and ready to push it into Claude's context.

log("Starting MCP server with claude/channel capability...");

const stdioTransport = new StdioServerTransport();
try {
	await mcp.connect(stdioTransport);
} catch (err) {
	log(`Fatal: MCP transport connection failed: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
}

await register();

intervals.push(setInterval(pollAndPush, POLL_INTERVAL));
intervals.push(setInterval(async () => {
	if (myPeerId) {
		try {
			await brokerPost("/heartbeat", { peerId: myPeerId });
		} catch (err) {
			log(`Heartbeat failed: ${err instanceof Error ? err.message : "unknown"}`);
		}
	}
}, HEARTBEAT_INTERVAL));

log(`Ready. Peer ID: ${myPeerId}`);
