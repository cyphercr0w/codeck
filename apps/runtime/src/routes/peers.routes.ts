/**
 * Peer Broker REST API
 *
 * HTTP endpoints for the peer message broker.
 * Used by the codeck-peer MCP server running inside each Claude Code session.
 */

import { Router } from "express";
import {
	registerPeer,
	unregisterPeer,
	heartbeat,
	updateSummary,
	listPeers,
	pollMessages,
	sendMessage,
	broadcastToExecution,
	getBrokerStats,
	getPeer,
} from "../services/peers/broker.js";
import { broadcast } from "../web/logger.js";

const router = Router();

// Health check
router.get("/health", (_req, res) => {
	const stats = getBrokerStats();
	res.json({ status: "ok", ...stats });
});

// Register a new peer
router.post("/register", (req, res) => {
	const { agentId, executionId, role, summary, pid, sessionId } = req.body;
	if (!agentId || !executionId) {
		res.status(400).json({ error: "agentId and executionId are required" });
		return;
	}
	// Validate pid: must be a plausible process ID (integer, > 1, < 4194304)
	// Reject pid=1 (init) to prevent stale-peer cleanup evasion via PID spoofing
	const pidValue =
		Number.isInteger(pid) && pid > 1 && pid < 4_194_304 ? pid : process.pid;
	const peer = registerPeer({
		agentId,
		executionId,
		role: role || agentId,
		summary: summary || "",
		pid: pidValue,
		sessionId: sessionId || "",
	});
	if (!peer) {
		res.status(503).json({ error: "Max peer limit reached" });
		return;
	}
	res.json({ peerId: peer.peerId });
});

// Unregister a peer
// TRUST BOUNDARY: No ownership check — any in-container process can unregister any peer.
// Acceptable because the container is the security perimeter.
router.post("/unregister", (req, res) => {
	const { peerId } = req.body;
	if (!peerId) {
		res.status(400).json({ error: "peerId is required" });
		return;
	}
	unregisterPeer(peerId);
	res.json({ ok: true });
});

// Heartbeat
router.post("/heartbeat", (req, res) => {
	const { peerId } = req.body;
	const ok = heartbeat(peerId);
	res.json({ ok });
});

// Update summary — also broadcast to frontend for real-time node graph
const MAX_SUMMARY_LENGTH = 500;

router.post("/set-summary", (req, res) => {
	const { peerId, summary } = req.body;
	if (!peerId) {
		res.status(400).json({ error: "peerId is required" });
		return;
	}
	// Sanitize: enforce string type, length cap, strip HTML tags
	const rawSummary = typeof summary === "string" ? summary : "";
	const safeSummary = rawSummary
		.slice(0, MAX_SUMMARY_LENGTH)
		.replace(/<[^>]*>/g, "");
	updateSummary(peerId, safeSummary);
	const peer = getPeer(peerId);
	if (peer) {
		broadcast({
			type: "flow:peer:summary",
			data: {
				executionId: peer.executionId,
				agentId: peer.agentId,
				summary: safeSummary,
			},
		});
	}
	res.json({ ok: true });
});

// List peers (optionally filtered by executionId)
router.post("/list-peers", (req, res) => {
	const { executionId, excludePeerId } = req.body;
	const peers = listPeers(executionId, excludePeerId);
	res.json(peers);
});

// Poll for messages
// TRUST BOUNDARY: No ownership check on peerId — any in-container process can poll.
// The container itself is the security perimeter. All peers run inside the same sandbox.
router.post("/poll-messages", (req, res) => {
	const { peerId } = req.body;
	if (!peerId) {
		res.status(400).json({ error: "peerId is required" });
		return;
	}
	const messages = pollMessages(peerId);
	res.json({ messages });
});

// Send a message to a specific peer
const MAX_PAYLOAD = 1_000_000; // 1 MB
const VALID_MSG_TYPES = new Set([
	"prompt",
	"response",
	"decision",
	"route",
	"system",
]);

router.post("/send-message", (req, res) => {
	const { from, to, type, payload, executionId } = req.body;
	if (!to || !payload || !executionId) {
		res
			.status(400)
			.json({ error: "to, payload, and executionId are required" });
		return;
	}
	if (typeof payload !== "string" || payload.length > MAX_PAYLOAD) {
		res
			.status(400)
			.json({ error: `payload must be a string under ${MAX_PAYLOAD} bytes` });
		return;
	}
	if (type && !VALID_MSG_TYPES.has(type)) {
		res.status(400).json({ error: `invalid message type: ${type}` });
		return;
	}
	// Validate sender identity — prevent orchestrator impersonation
	const senderId = from || "orchestrator";
	if (senderId.startsWith("orch-")) {
		const orchPeer = getPeer(senderId);
		if (!orchPeer || orchPeer.role !== "orchestrator") {
			res.status(403).json({ error: "Orchestrator peer not registered" });
			return;
		}
	} else if (senderId !== "orchestrator") {
		const senderPeer = getPeer(senderId);
		if (!senderPeer) {
			res.status(403).json({ error: "Sender peer not registered" });
			return;
		}
	}
	const msg = sendMessage(
		from || "orchestrator",
		to,
		type || "prompt",
		payload,
		executionId,
	);
	if (!msg) {
		res.status(404).json({ error: "Peer not found" });
		return;
	}
	res.json({ ok: true, messageId: msg.id });
});

// Broadcast to all peers in an execution
router.post("/broadcast", (req, res) => {
	const { from, type, payload, executionId } = req.body;
	if (!payload || !executionId) {
		res.status(400).json({ error: "payload and executionId are required" });
		return;
	}
	if (typeof payload !== "string" || payload.length > MAX_PAYLOAD) {
		res
			.status(400)
			.json({ error: `payload must be a string under ${MAX_PAYLOAD} bytes` });
		return;
	}
	if (type && !VALID_MSG_TYPES.has(type)) {
		res.status(400).json({ error: `invalid message type: ${type}` });
		return;
	}
	// Validate sender identity — same check as /send-message
	const senderId = from || "orchestrator";
	if (senderId.startsWith("orch-")) {
		const orchPeer = getPeer(senderId);
		if (!orchPeer || orchPeer.role !== "orchestrator") {
			res.status(403).json({ error: "Orchestrator peer not registered" });
			return;
		}
	} else if (senderId !== "orchestrator") {
		const senderPeer = getPeer(senderId);
		if (!senderPeer) {
			res.status(403).json({ error: "Sender peer not registered" });
			return;
		}
	}
	broadcastToExecution(senderId, type || "system", payload, executionId);
	res.json({ ok: true });
});

export default router;
