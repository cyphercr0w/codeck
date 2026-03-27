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

import type {
	PeerInfo,
	PeerMessage,
	PeerMessageType,
	BrokerState,
} from "./types.js";
import { broadcast } from "../../web/logger.js";

// ── Singleton state ──

const state: BrokerState = {
	peers: new Map(),
	queues: new Map(),
	messageCounter: 0,
};

// ── Peer lifecycle ──

function generatePeerId(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function registerPeer(
	info: Omit<PeerInfo, "peerId" | "registeredAt" | "lastPollAt"> & {
		fixedPeerId?: string;
	},
): PeerInfo {
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
		`[Broker] Registered peer ${peerId} (agent=${info.agentId}, exec=${info.executionId}, pid=${info.pid})`,
	);

	// Broadcast to frontend
	broadcast({
		type: "flow:peer:session_created",
		data: {
			executionId: info.executionId,
			agentId: info.agentId,
			sessionId: info.sessionId,
			peerId,
		},
	});

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
		`[Broker] Message #${msg.id}: ${from} -> ${to} [${type}] (${payload.slice(0, 80)}${payload.length > 80 ? "..." : ""})`,
	);

	// Broadcast for frontend real-time visibility
	broadcast({
		type: "flow:peer:message",
		data: {
			executionId,
			from,
			to,
			messageType: type,
			payload: payload.slice(0, 500),
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

/** Remove stale peers that haven't polled in 60 seconds */
export function cleanStalePeers(): void {
	const now = Date.now();
	const staleThreshold = 60_000;
	for (const [id, peer] of state.peers) {
		if (now - peer.lastPollAt > staleThreshold) {
			// Verify PID is alive
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

// Run cleanup every 30 seconds
setInterval(cleanStalePeers, 30_000);

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
