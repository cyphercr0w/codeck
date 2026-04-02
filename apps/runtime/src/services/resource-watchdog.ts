/**
 * Resource Watchdog — monitors PIDs, CPU, and memory while Agent Teams are active.
 *
 * Activates when teams are detected, polls every 5s, logs warnings at threshold,
 * and dumps process tree at critical PID levels. Writes persistent log to
 * /workspace/.codeck/logs/watchdog.log for post-crash diagnostics.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
} from "fs";
import {
	getContainerResources,
	getPidUsage,
	getProcessTree,
} from "./resources.js";
import { broadcast } from "../web/logger.js";

const POLL_INTERVAL = 5000;
const PID_WARN_RATIO = 0.78;
const PID_CRITICAL_RATIO = 0.93;
const MEM_WARN_PERCENT = 80;
const CPU_WARN_PERCENT = 90;

const LOG_DIR = "/workspace/.codeck/logs";
const LOG_FILE = `${LOG_DIR}/watchdog.log`;
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let pollTimer: ReturnType<typeof setInterval> | null = null;
let teamCount = 0;
let polling = false;

function ensureLogDir(): void {
	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, { recursive: true });
	}
}

function writeLog(line: string): void {
	try {
		ensureLogDir();
		// Simple rotation: if over max size, rename to .log.1
		if (existsSync(LOG_FILE)) {
			const stats = statSync(LOG_FILE);
			if (stats.size > MAX_LOG_SIZE) {
				renameSync(LOG_FILE, `${LOG_FILE}.1`);
			}
		}
		appendFileSync(LOG_FILE, line + "\n");
	} catch {
		// Logging should never crash the runtime
	}
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0B";
	const gb = bytes / (1024 * 1024 * 1024);
	if (gb >= 1) return `${gb.toFixed(1)}GB`;
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(0)}MB`;
}

async function poll(): Promise<void> {
	if (polling) return;
	polling = true;
	try {
		const resources = getContainerResources();
		const pids = getPidUsage();
		const timestamp = new Date().toISOString();

		const pidRatio = pids.limit > 0 ? pids.current / pids.limit : 0;
		const memPercent = resources.memory.percent;
		const cpuPercent = resources.cpu.usagePercent;

		const logLine = `[${timestamp}] PIDs: ${pids.current}/${pids.limit} | MEM: ${formatBytes(resources.memory.used)}/${formatBytes(resources.memory.limit)} (${memPercent}%) | CPU: ${cpuPercent}% | Sessions: ${resources.sessions}`;

		// Check thresholds
		const warnings: string[] = [];

		if (pids.limit > 0 && pidRatio >= PID_CRITICAL_RATIO) {
			warnings.push(
				`CRITICAL: PID usage ${pids.current}/${pids.limit} (${(pidRatio * 100).toFixed(0)}%)`,
			);
		} else if (pids.limit > 0 && pidRatio >= PID_WARN_RATIO) {
			warnings.push(
				`WARNING: PID usage ${pids.current}/${pids.limit} (${(pidRatio * 100).toFixed(0)}%)`,
			);
		}

		if (memPercent >= MEM_WARN_PERCENT) {
			warnings.push(
				`WARNING: Memory ${formatBytes(resources.memory.used)}/${formatBytes(resources.memory.limit)} (${memPercent}%)`,
			);
		}

		if (cpuPercent >= CPU_WARN_PERCENT) {
			warnings.push(`WARNING: CPU ${cpuPercent}%`);
		}

		if (warnings.length > 0) {
			const warningMsg = `[Watchdog] ${warnings.join(" | ")}`;
			console.warn(warningMsg);
			writeLog(`${logLine} *** ${warnings.join(" | ")}`);
			broadcast({
				type: "watchdog:warning",
				data: {
					pids: { current: pids.current, limit: pids.limit },
					memory: {
						used: resources.memory.used,
						limit: resources.memory.limit,
						percent: memPercent,
					},
					cpu: cpuPercent,
					sessions: resources.sessions,
					warnings,
					timestamp,
				},
			});

			// On critical PID threshold, dump process tree
			if (pids.limit > 0 && pidRatio >= PID_CRITICAL_RATIO) {
				console.error(
					`[Watchdog] CRITICAL: PID usage at ${pids.current}/${pids.limit} — dumping process tree`,
				);
				const tree = await getProcessTree();
				if (tree) {
					writeLog(`--- PROCESS TREE DUMP (${timestamp}) ---`);
					writeLog(tree);
					writeLog(`--- END PROCESS TREE DUMP ---`);
				}
			}
		}
	} finally {
		polling = false;
	}
}

/**
 * Start the watchdog. Called once at server startup.
 * Polling only runs while teams are active (teamCount > 0).
 */
export function startWatchdog(): void {
	ensureLogDir();
	console.log("[Watchdog] Initialized — will activate when teams are detected");
}

/**
 * Stop the watchdog. Called on graceful shutdown.
 */
export function stopWatchdog(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	teamCount = 0;
	console.log("[Watchdog] Stopped");
}

/**
 * Notify that a team session started. Activates polling if not already running.
 */
export function notifyTeamActive(): void {
	teamCount++;
	if (!pollTimer) {
		pollTimer = setInterval(() => {
			poll().catch(() => {});
		}, POLL_INTERVAL);
		// Run immediately on first team detection
		poll().catch(() => {});
		console.log("[Watchdog] Activated — monitoring resources every 5s");
		writeLog(
			`[${new Date().toISOString()}] Watchdog activated — team detected`,
		);
	}
}

/**
 * Notify that a team session ended. Deactivates polling when no teams remain.
 */
export function notifyTeamEnded(): void {
	teamCount = Math.max(0, teamCount - 1);
	if (teamCount <= 0 && pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
		console.log("[Watchdog] Deactivated — no active teams");
		writeLog(
			`[${new Date().toISOString()}] Watchdog deactivated — no active teams`,
		);
	}
}
