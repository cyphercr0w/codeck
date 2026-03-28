/**
 * AgentCanvas — Real-time canvas visualization of Agent Teams.
 *
 * Renders agents as circular nodes with status indicators,
 * flowing particles for inter-agent communication, and
 * d3-force-based physics layout. Inspired by patoles/agent-flow.
 *
 * Performance: All rendering happens in Canvas 2D at 60fps.
 * React state updates are throttled to ~250ms for UI overlays.
 */

import { type FunctionalComponent } from "preact";
import { useEffect, useRef, useCallback } from "preact/hooks";
import {
	activeTeam,
	selectedAgentSessionId,
	selectTeamAgent,
} from "../../state/team-store";
import {
	forceSimulation,
	forceManyBody,
	forceCenter,
	forceCollide,
	forceLink,
	type SimulationNodeDatum,
	type SimulationLinkDatum,
} from "d3-force";

// ── Constants ──

const COLORS = {
	bg: "#0a0e14",
	nodeFill: "#161b22",
	nodeStroke: "#30363d",
	nodeStrokeActive: "#3d5afe",
	leader: "#f59e0b",
	agentIdle: "#6b7280",
	agentWorking: "#3d5afe",
	agentDetected: "#22c55e",
	text: "#e1e4e8",
	textDim: "#6b7280",
	particle: "#3d5afe",
	particleReturn: "#22c55e",
	edge: "#1e2430",
	edgeActive: "#3d5afe33",
	glow: "rgba(61, 90, 254, 0.15)",
};

const NODE_RADIUS = 32;
const LEADER_RADIUS = 38;
const LABEL_OFFSET = 14;
const PARTICLE_SPEED = 0.8;
const STATUS_DOT_R = 5;

// ── Types ──

interface AgentNode extends SimulationNodeDatum {
	id: string;
	name: string;
	role: string;
	isLeader: boolean;
	status: string;
	sessionId: string;
}

interface AgentEdge extends SimulationLinkDatum<AgentNode> {
	id: string;
}

interface Particle {
	edgeId: string;
	progress: number;
	speed: number;
	color: string;
	size: number;
}

// ── Drawing helpers ──

function drawNode(
	ctx: CanvasRenderingContext2D,
	node: AgentNode,
	isSelected: boolean,
	isHovered: boolean,
	time: number,
): void {
	const x = node.x ?? 0;
	const y = node.y ?? 0;
	const r = node.isLeader ? LEADER_RADIUS : NODE_RADIUS;

	// Glow for selected/working nodes
	if (isSelected || node.status === "running" || node.status === "detected") {
		const color = node.isLeader ? COLORS.leader : COLORS.nodeStrokeActive;
		const glowR = r + 12 + Math.sin(time * 2) * 3;
		const grad = ctx.createRadialGradient(x, y, r, x, y, glowR);
		grad.addColorStop(0, color + "30");
		grad.addColorStop(1, color + "00");
		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.arc(x, y, glowR, 0, Math.PI * 2);
		ctx.fill();
	}

	// Node circle
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fillStyle = COLORS.nodeFill;
	ctx.fill();

	// Border
	ctx.strokeStyle = isSelected
		? COLORS.nodeStrokeActive
		: isHovered
			? COLORS.text
			: COLORS.nodeStroke;
	ctx.lineWidth = isSelected ? 2.5 : 1.5;
	ctx.stroke();

	// Status dot (top-right)
	const dotX = x + r * 0.65;
	const dotY = y - r * 0.65;
	ctx.beginPath();
	ctx.arc(dotX, dotY, STATUS_DOT_R, 0, Math.PI * 2);

	const statusColor =
		node.status === "detected" || node.status === "running"
			? COLORS.agentDetected
			: node.status === "idle" || node.status === "shutdown"
				? COLORS.agentIdle
				: node.isLeader
					? COLORS.leader
					: COLORS.agentIdle;
	ctx.fillStyle = statusColor;
	ctx.fill();

	// Pulse ring for working status
	if (node.status === "detected" || node.status === "running") {
		const pulseR = STATUS_DOT_R + 3 + Math.sin(time * 3) * 2;
		ctx.beginPath();
		ctx.arc(dotX, dotY, pulseR, 0, Math.PI * 2);
		ctx.strokeStyle = statusColor + "60";
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	// Name label
	ctx.fillStyle = COLORS.text;
	ctx.font = "600 12px 'IBM Plex Mono', monospace";
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	ctx.fillText(node.name, x, y + r + LABEL_OFFSET);

	// Role sublabel
	ctx.fillStyle = COLORS.textDim;
	ctx.font = "400 10px 'IBM Plex Mono', monospace";
	ctx.fillText(node.role, x, y + r + LABEL_OFFSET + 16);

	// Agent icon (simple initial)
	ctx.fillStyle = node.isLeader ? COLORS.leader : COLORS.nodeStrokeActive;
	ctx.font = "700 16px 'IBM Plex Mono', monospace";
	ctx.textBaseline = "middle";
	ctx.fillText(node.name.charAt(0).toUpperCase(), x, y);
}

function drawEdge(
	ctx: CanvasRenderingContext2D,
	source: AgentNode,
	target: AgentNode,
	_time: number,
): void {
	const sx = source.x ?? 0;
	const sy = source.y ?? 0;
	const tx = target.x ?? 0;
	const ty = target.y ?? 0;

	// Curved edge with bezier
	const dx = tx - sx;
	const dy = ty - sy;
	const dist = Math.sqrt(dx * dx + dy * dy);
	if (dist < 1) return; // Nodes overlap — skip to avoid NaN

	const curvature = dist * 0.12;
	const perpX = (-dy / dist) * curvature;
	const perpY = (dx / dist) * curvature;
	const cpx = (sx + tx) / 2 + perpX;
	const cpy = (sy + ty) / 2 + perpY;

	ctx.beginPath();
	ctx.moveTo(sx, sy);
	ctx.quadraticCurveTo(cpx, cpy, tx, ty);
	ctx.strokeStyle = COLORS.edge;
	ctx.lineWidth = 1.5;
	ctx.stroke();
}

function drawParticle(
	ctx: CanvasRenderingContext2D,
	p: Particle,
	source: AgentNode,
	target: AgentNode,
): void {
	const sx = source.x ?? 0;
	const sy = source.y ?? 0;
	const tx = target.x ?? 0;
	const ty = target.y ?? 0;

	// Interpolate along edge
	const t = p.progress;
	const dx = tx - sx;
	const dy = ty - sy;
	const dist = Math.sqrt(dx * dx + dy * dy);
	if (dist < 1) return; // Nodes overlap — skip to avoid NaN

	const curvature = dist * 0.12;
	const perpX = (-dy / dist) * curvature;
	const perpY = (dx / dist) * curvature;
	const cpx = (sx + tx) / 2 + perpX;
	const cpy = (sy + ty) / 2 + perpY;

	// Quadratic bezier point
	const mt = 1 - t;
	const px = mt * mt * sx + 2 * mt * t * cpx + t * t * tx;
	const py = mt * mt * sy + 2 * mt * t * cpy + t * t * ty;

	// Glow
	const grad = ctx.createRadialGradient(px, py, 0, px, py, p.size * 4);
	grad.addColorStop(0, p.color + "60");
	grad.addColorStop(1, p.color + "00");
	ctx.fillStyle = grad;
	ctx.beginPath();
	ctx.arc(px, py, p.size * 4, 0, Math.PI * 2);
	ctx.fill();

	// Core
	ctx.fillStyle = p.color;
	ctx.beginPath();
	ctx.arc(px, py, p.size, 0, Math.PI * 2);
	ctx.fill();
}

// ── Component ──

const AgentCanvas: FunctionalComponent<{
	onAgentClick?: (sessionId: string) => void;
}> = ({ onAgentClick }) => {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const nodesRef = useRef<AgentNode[]>([]);
	const edgesRef = useRef<AgentEdge[]>([]);
	const particlesRef = useRef<Particle[]>([]);
	const hoveredRef = useRef<string | null>(null);
	const animFrameRef = useRef<number>(0);
	const simRef = useRef<ReturnType<typeof forceSimulation<AgentNode>> | null>(
		null,
	);

	// Sync team state → nodes/edges
	const syncNodes = useCallback(() => {
		const team = activeTeam.value;
		if (!team) {
			nodesRef.current = [];
			edgesRef.current = [];
			return;
		}

		// Build nodes: leader + ALL agents (even pending — shown as gray/unclickable)
		const nodes: AgentNode[] = [
			{
				id: "leader",
				name: "Leader",
				role: "Team Lead",
				isLeader: true,
				status: team.status === "running" ? "running" : "idle",
				sessionId: team.leaderSessionId,
			},
			...team.agents.map((a) => ({
				id: a.id,
				name: a.name,
				role: a.role,
				isLeader: false,
				status: a.status,
				sessionId: a.sessionId ?? "",
			})),
		];

		// Preserve positions from existing nodes
		for (const node of nodes) {
			const existing = nodesRef.current.find((n) => n.id === node.id);
			if (existing) {
				node.x = existing.x;
				node.y = existing.y;
			}
		}

		// Edges: leader → each agent
		const edges: AgentEdge[] = nodes
			.filter((n) => !n.isLeader)
			.map((n) => ({
				id: `leader-${n.id}`,
				source: "leader",
				target: n.id,
			}));

		nodesRef.current = nodes;
		edgesRef.current = edges;

		// Update d3 simulation
		if (simRef.current) {
			simRef.current.nodes(nodes);
			const linkForce = simRef.current.force("link") as
				| ReturnType<typeof forceLink<AgentNode, AgentEdge>>
				| undefined;
			if (linkForce) linkForce.links(edges);
			simRef.current.alpha(0.3).restart();
		}

		// Spawn particles for active agents
		for (const agent of nodes) {
			if (
				(agent.status === "detected" || agent.status === "running") &&
				!agent.isLeader
			) {
				if (Math.random() < 0.02) {
					particlesRef.current.push({
						edgeId: `leader-${agent.id}`,
						progress: 0,
						speed: PARTICLE_SPEED + Math.random() * 0.3,
						color: COLORS.particle,
						size: 2 + Math.random() * 1.5,
					});
				}
				// Return particles (less frequent)
				if (Math.random() < 0.01) {
					particlesRef.current.push({
						edgeId: `leader-${agent.id}`,
						progress: 1,
						speed: -(PARTICLE_SPEED + Math.random() * 0.2),
						color: COLORS.particleReturn,
						size: 2,
					});
				}
			}
		}

		// Cap particles
		if (particlesRef.current.length > 50) {
			particlesRef.current = particlesRef.current.slice(-40);
		}
	}, []);

	// Initialize d3-force simulation
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const w = canvas.clientWidth;
		const h = canvas.clientHeight;

		const sim = forceSimulation<AgentNode>([])
			.force("charge", forceManyBody().strength(-400))
			.force("center", forceCenter(w / 2, h / 2).strength(0.05))
			.force("collide", forceCollide<AgentNode>(80))
			.force(
				"link",
				forceLink<AgentNode, AgentEdge>()
					.id((d) => d.id)
					.distance(180)
					.strength(0.5),
			)
			.alphaDecay(0.02)
			.velocityDecay(0.4)
			.stop(); // We tick manually in the render loop

		simRef.current = sim;

		return () => {
			sim.stop();
			simRef.current = null;
		};
	}, []);

	// Animation loop
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		let startTime = performance.now();

		const render = (timestamp: number) => {
			const time = (timestamp - startTime) / 1000;
			const dpr = window.devicePixelRatio || 1;
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;

			// Resize canvas if needed
			if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
				canvas.width = w * dpr;
				canvas.height = h * dpr;

				// Re-center force
				const centerForce = simRef.current?.force("center") as
					| ReturnType<typeof forceCenter>
					| undefined;
				if (centerForce) centerForce.x(w / 2).y(h / 2);
			}

			// Sync state
			syncNodes();

			// Tick physics and clamp nodes inside canvas bounds
			if (simRef.current) {
				for (let i = 0; i < 3; i++) simRef.current.tick();
			}
			const pad = LEADER_RADIUS + LABEL_OFFSET + 32; // room for labels
			for (const node of nodesRef.current) {
				if (node.x !== undefined)
					node.x = Math.max(pad, Math.min(w - pad, node.x));
				if (node.y !== undefined)
					node.y = Math.max(pad, Math.min(h - pad, node.y));
			}

			// Update particles
			particlesRef.current = particlesRef.current.filter((p) => {
				p.progress += p.speed * 0.016;
				return p.progress >= 0 && p.progress <= 1;
			});

			const nodes = nodesRef.current;
			const edges = edgesRef.current;
			const particles = particlesRef.current;
			const hovered = hoveredRef.current;

			// Reset transform to DPR scale (prevents accumulation on resize)
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);

			// Draw edges
			for (const edge of edges) {
				const src = nodes.find(
					(n) =>
						n.id ===
						(typeof edge.source === "string"
							? edge.source
							: (edge.source as AgentNode).id),
				);
				const tgt = nodes.find(
					(n) =>
						n.id ===
						(typeof edge.target === "string"
							? edge.target
							: (edge.target as AgentNode).id),
				);
				if (src && tgt) drawEdge(ctx, src, tgt, time);
			}

			// Draw particles
			for (const p of particles) {
				const edge = edges.find((e) => e.id === p.edgeId);
				if (!edge) continue;
				const src = nodes.find(
					(n) =>
						n.id ===
						(typeof edge.source === "string"
							? edge.source
							: (edge.source as AgentNode).id),
				);
				const tgt = nodes.find(
					(n) =>
						n.id ===
						(typeof edge.target === "string"
							? edge.target
							: (edge.target as AgentNode).id),
				);
				if (src && tgt) drawParticle(ctx, p, src, tgt);
			}

			// Draw nodes
			for (const node of nodes) {
				drawNode(
					ctx,
					node,
					node.sessionId === selectedAgentSessionId.value,
					node.id === hovered,
					time,
				);
			}

			animFrameRef.current = requestAnimationFrame(render);
		};

		animFrameRef.current = requestAnimationFrame(render);
		return () => cancelAnimationFrame(animFrameRef.current);
	}, [syncNodes]);

	// Mouse interaction
	const handleMouseMove = useCallback((e: MouseEvent) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;

		const hit = nodesRef.current.find((n) => {
			const r = n.isLeader ? LEADER_RADIUS : NODE_RADIUS;
			const dx = (n.x ?? 0) - mx;
			const dy = (n.y ?? 0) - my;
			return dx * dx + dy * dy <= r * r;
		});
		hoveredRef.current = hit?.id ?? null;
		canvas.style.cursor = hit?.sessionId ? "pointer" : "default";
	}, []);

	const handleClick = useCallback(
		(e: MouseEvent) => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			const rect = canvas.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;

			const hit = nodesRef.current.find((n) => {
				const r = n.isLeader ? LEADER_RADIUS : NODE_RADIUS;
				const dx = (n.x ?? 0) - mx;
				const dy = (n.y ?? 0) - my;
				return dx * dx + dy * dy <= r * r;
			});

			if (hit && hit.sessionId) {
				selectTeamAgent(hit.sessionId);
				onAgentClick?.(hit.sessionId);
			}
		},
		[onAgentClick],
	);

	return (
		<canvas
			ref={canvasRef}
			onMouseMove={handleMouseMove as any}
			onClick={handleClick as any}
			style="width:100%;height:100%;display:block;background:#0a0e14;"
		/>
	);
};

export default AgentCanvas;
