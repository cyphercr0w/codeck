/**
 * Peer Message Broker
 *
 * In-process HTTP-style message broker for inter-agent communication.
 * Manages peer registration, message queuing, and delivery.
 *
 * Runs inside the main runtime process — no separate daemon needed.
 * Peers (Claude Code sessions with codeck-peer MCP) register via HTTP,
 * poll for messages, and receive them via claude/channel push.
 */

import { randomBytes } from "crypto";
import type {
	PeerInfo,
	PeerMessage,
	PeerMessageType,
	BrokerState,
} from "./types.js";
import { broadcast } from "../../web/logger.js";

/** Strip control characters from user-supplied strings before logging */
const sanitizeLog = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, "?");

// ── Singleton state ──

const state: BrokerState = {
	peers: new Map(),
	queues: new Map(),
	messageCounter: 0,
};

// ── Peer lifecycle ──

const MAX_PEERS = 100;

function generatePeerId(): string {
	return randomBytes(6).toString("base64url");
}

export function registerPeer(
	info: Omit<PeerInfo, "peerId" | "registeredAt" | "lastPollAt"> & {
		fixedPeerId?: string;
	},
): PeerInfo | null {
	if (state.peers.size >= MAX_PEERS) {
		console.warn(
			`[Broker] Max peer limit (${MAX_PEERS}) reached — rejecting registration for agent=${info.agentId}`,
		);
		return null;
	}

	const peerId = info.fixedPeerId || generatePeerId();
	const peer: PeerInfo = {
		...info,
		peerId,
		registeredAt: Date.now(),
		lastPollAt: Date.now(),
	};
	state.peers.set(peerId, peer);
	state.queues.set(peerId, []);

	console.log(
		`[Broker] Registered peer ${peerId} (agent=${sanitizeLog(info.agentId)}, exec=${sanitizeLog(info.executionId)}, pid=${info.pid})`,
	);

	// NOTE: Do NOT broadcast flow:peer:session_created here.
	// peer-flow-runner.ts already broadcasts it with the correct console session ID.
	// The broker's info.sessionId is PEER_SESSION_ID (MCP env var), which is different
	// from the console session ID used for terminal attachment. Broadcasting here
	// would overwrite the correct ID with the wrong one.

	return peer;
}

export function unregisterPeer(peerId: string): void {
	state.peers.delete(peerId);
	state.queues.delete(peerId);
	console.log(`[Broker] Unregistered peer ${peerId}`);
}

export function heartbeat(peerId: string): boolean {
	const peer = state.peers.get(peerId);
	if (!peer) return false;
	peer.lastPollAt = Date.now();
	return true;
}

export function updateSummary(peerId: string, summary: string): void {
	const peer = state.peers.get(peerId);
	if (peer) peer.summary = summary;
}

// ── Peer discovery ──

export function listPeers(
	executionId?: string,
	excludePeerId?: string,
): PeerInfo[] {
	const result: PeerInfo[] = [];
	for (const [id, peer] of state.peers) {
		if (excludePeerId && id === excludePeerId) continue;
		if (executionId && peer.executionId !== executionId) continue;
		result.push(peer);
	}
	return result;
}

export function getPeer(peerId: string): PeerInfo | undefined {
	return state.peers.get(peerId);
}

export function findPeerByAgent(
	executionId: string,
	agentId: string,
): PeerInfo | undefined {
	for (const peer of state.peers.values()) {
		if (peer.executionId === executionId && peer.agentId === agentId) {
			return peer;
		}
	}
	return undefined;
}

// ── Messaging ──

const MAX_QUEUE_DEPTH = 1000;

export function sendMessage(
	from: string,
	to: string,
	type: PeerMessageType,
	payload: string,
	executionId: string,
): PeerMessage | null {
	const queue = state.queues.get(to);
	if (!queue) {
		console.warn(`[Broker] Cannot send to ${to} — peer not found`);
		return null;
	}

	if (queue.length >= MAX_QUEUE_DEPTH) {
		console.warn(
			`[Broker] Queue full for ${to} (${queue.length} messages) — dropping message from ${from}`,
		);
		return null;
	}

	// Prevent cross-execution message injection (#3)
	const targetPeer = state.peers.get(to);
	if (targetPeer && targetPeer.executionId !== executionId) {
		console.warn(`[Broker] Cross-execution send blocked: ${from} -> ${to}`);
		return null;
	}

	// Validate sender is a registered peer in the same execution or the orchestrator
	const isOrchestrator = from.startsWith("orch-");
	if (!isOrchestrator) {
		const senderPeer = state.peers.get(from);
		if (!senderPeer || senderPeer.executionId !== executionId) {
			console.warn(
				`[Broker] Send from unregistered/cross-execution peer blocked: ${from} -> ${to}`,
			);
			return null;
		}
	}

	const msg: PeerMessage = {
		id: ++state.messageCounter,
		from,
		to,
		type,
		payload,
		timestamp: Date.now(),
		executionId,
	};

	queue.push(msg);

	console.log(
		`[Broker] Message #${msg.id}: ${from} -> ${to} [${type}] (${sanitizeLog(payload.slice(0, 80))}${payload.length > 80 ? "..." : ""})`,
	);

	// Broadcast metadata-only event for frontend real-time visibility
	// Payloads may contain sensitive data — do not forward to WebSocket clients
	const fromPeer = state.peers.get(from);
	const toPeer = state.peers.get(to);
	broadcast({
		type: "flow:peer:message",
		data: {
			executionId,
			from,
			to,
			fromAgentId: fromPeer?.agentId || from,
			toAgentId: toPeer?.agentId || to,
			messageType: type,
			messageId: msg.id,
		},
	});

	return msg;
}

export function broadcastToExecution(
	from: string,
	type: PeerMessageType,
	payload: string,
	executionId: string,
): void {
	for (const [peerId, peer] of state.peers) {
		if (peer.executionId === executionId && peerId !== from) {
			sendMessage(from, peerId, type, payload, executionId);
		}
	}
}

export function pollMessages(peerId: string): PeerMessage[] {
	const peer = state.peers.get(peerId);
	if (peer) peer.lastPollAt = Date.now();

	const queue = state.queues.get(peerId);
	if (!queue || queue.length === 0) return [];

	// Drain the queue — delivery-once semantics
	const messages = [...queue];
	queue.length = 0;
	return messages;
}

// ── Cleanup ──

/** Remove all peers for a given execution (flow completed/cancelled) */
export function cleanupExecution(executionId: string): void {
	const toRemove: string[] = [];
	for (const [id, peer] of state.peers) {
		if (peer.executionId === executionId) {
			toRemove.push(id);
		}
	}
	for (const id of toRemove) {
		state.peers.delete(id);
		state.queues.delete(id);
	}
	if (toRemove.length > 0) {
		console.log(
			`[Broker] Cleaned up ${toRemove.length} peers for execution ${executionId}`,
		);
	}
}

/** Remove stale peers that haven't polled recently */
export function cleanStalePeers(): void {
	const now = Date.now();
	const staleThreshold = 60_000; // 60s — remove if PID is dead
	const hardStaleThreshold = 300_000; // 5min — remove unconditionally
	for (const [id, peer] of state.peers) {
		const staleDuration = now - peer.lastPollAt;
		if (staleDuration > hardStaleThreshold) {
			// Unconditional removal — MCP server likely crashed while host process lives
			console.log(
				`[Broker] Removing hard-stale peer ${id} (no poll for ${Math.round(staleDuration / 1000)}s)`,
			);
			state.peers.delete(id);
			state.queues.delete(id);
		} else if (staleDuration > staleThreshold) {
			// Soft stale — only remove if PID is dead
			try {
				process.kill(peer.pid, 0);
			} catch {
				console.log(
					`[Broker] Removing stale peer ${id} (pid ${peer.pid} dead)`,
				);
				state.peers.delete(id);
				state.queues.delete(id);
			}
		}
	}
}

// Run cleanup every 30 seconds — unref so it doesn't block process exit
export const cleanupInterval = setInterval(cleanStalePeers, 30_000);
cleanupInterval.unref();

// ── Stats ──

export function getBrokerStats(): {
	peerCount: number;
	queuedMessages: number;
	totalMessages: number;
} {
	let queuedMessages = 0;
	for (const queue of state.queues.values()) {
		queuedMessages += queue.length;
	}
	return {
		peerCount: state.peers.size,
		queuedMessages,
		totalMessages: state.messageCounter,
	};
}
