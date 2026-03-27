/**
 * Peer orchestration — shared types
 *
 * Types used by the broker, peer MCP server, and peer flow runner.
 */

// ── Peer Messages ──

export type PeerMessageType =
	| "prompt" // Initial prompt from orchestrator
	| "response" // Agent's response/output
	| "decision" // Structured decision (APPROVE, REQUEST_CHANGES, etc.)
	| "route" // Routing instruction from orchestrator
	| "system"; // System messages (cancel, timeout, etc.)

export interface PeerMessage {
	id: number;
	from: string; // peerId or "orchestrator"
	to: string; // peerId
	type: PeerMessageType;
	payload: string;
	timestamp: number;
	executionId: string;
}

// ── Peer Registration ──

export interface PeerInfo {
	peerId: string;
	agentId: string; // matches AgentDefinition.id from flow
	executionId: string;
	role: string;
	summary: string;
	pid: number;
	sessionId: string; // PTY session ID for frontend terminal attachment
	registeredAt: number;
	lastPollAt: number;
}

// ── Broker State ──

export interface BrokerState {
	peers: Map<string, PeerInfo>;
	queues: Map<string, PeerMessage[]>; // peerId -> undelivered messages
	messageCounter: number;
}

// ── WebSocket Events ──

export interface PeerSessionCreatedEvent {
	type: "flow:peer:session_created";
	data: {
		executionId: string;
		agentId: string;
		sessionId: string;
		peerId: string;
	};
}

export interface PeerMessageEvent {
	type: "flow:peer:message";
	data: {
		executionId: string;
		from: string;
		to: string;
		messageType: PeerMessageType;
		payload: string;
	};
}
