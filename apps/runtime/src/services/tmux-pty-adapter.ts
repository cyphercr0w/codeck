/**
 * TmuxPtyAdapter — IPty-compatible wrapper for a tmux pane.
 *
 * Bridges a tmux pane into the ConsoleSession infrastructure so
 * the existing WebSocket pipeline (console:attach/output/input/resize)
 * works without modification.
 *
 * Output: `tmux pipe-pane -O` streams raw program output to a temp file,
 *         which we tail via a child process for real-time data.
 * Input:  `tmux send-keys -t pane` forwards keystrokes.
 * Resize: `tmux resize-pane -t pane` adjusts dimensions.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { IPty } from "node-pty";

// ── Types ──

interface IDisposable {
	dispose(): void;
}

type DataCallback = (data: string) => void;
type ExitCallback = (e: { exitCode: number; signal?: number }) => void;

// ── Special key mapping (xterm.js escape sequences → tmux key names) ──

const SPECIAL_KEYS: ReadonlyMap<string, string> = new Map([
	["\r", "Enter"],
	["\n", "Enter"],
	["\x7f", "BSpace"],
	["\t", "Tab"],
	["\x1b", "Escape"],
	["\x1b[A", "Up"],
	["\x1b[B", "Down"],
	["\x1b[C", "Right"],
	["\x1b[D", "Left"],
	["\x1b[H", "Home"],
	["\x1b[F", "End"],
	["\x1b[2~", "IC"], // Insert
	["\x1b[3~", "DC"], // Delete
	["\x1b[5~", "PPage"], // Page Up
	["\x1b[6~", "NPage"], // Page Down
	["\x03", "C-c"],
	["\x04", "C-d"],
	["\x1a", "C-z"],
	["\x0c", "C-l"],
	["\x01", "C-a"],
	["\x05", "C-e"],
	["\x0b", "C-k"],
	["\x15", "C-u"],
	["\x17", "C-w"],
]);

const TMUX_CMD = "tmux";
const PIPE_DIR = "/tmp/codeck-tmux-pipes";

export class TmuxPtyAdapter implements Partial<IPty> {
	readonly paneTarget: string;
	readonly pid: number;
	cols: number;
	rows: number;
	process: string;
	handleFlowControl = false;

	private dataCallbacks: DataCallback[] = [];
	private exitCallbacks: ExitCallback[] = [];
	private tailProcess: ChildProcess | null = null;
	private pipePath: string;
	private destroyed = false;
	private paused = false;

	constructor(paneTarget: string, options?: { cols?: number; rows?: number }) {
		this.paneTarget = paneTarget;
		this.cols = options?.cols ?? 120;
		this.rows = options?.rows ?? 30;
		this.process = "claude";
		this.pid = this.readPanePid();
		this.pipePath = join(
			PIPE_DIR,
			`pane-${paneTarget.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`,
		);

		this.startOutputPipe();
	}

	// ── IPty interface ──

	onData(callback: DataCallback): IDisposable {
		this.dataCallbacks.push(callback);
		return {
			dispose: () => {
				const idx = this.dataCallbacks.indexOf(callback);
				if (idx >= 0) this.dataCallbacks.splice(idx, 1);
			},
		};
	}

	onExit(callback: ExitCallback): IDisposable {
		this.exitCallbacks.push(callback);
		return {
			dispose: () => {
				const idx = this.exitCallbacks.indexOf(callback);
				if (idx >= 0) this.exitCallbacks.splice(idx, 1);
			},
		};
	}

	write(data: string): void {
		if (this.destroyed) return;

		// Check for special keys first
		const special = SPECIAL_KEYS.get(data);
		if (special) {
			this.tmuxSendKey(special);
			return;
		}

		// Check for multi-byte escape sequences not in the map
		if (data.startsWith("\x1b[") || data.startsWith("\x1bO")) {
			// Try the full sequence
			const seq = SPECIAL_KEYS.get(data);
			if (seq) {
				this.tmuxSendKey(seq);
				return;
			}
		}

		// Send as literal text
		this.tmuxSendLiteral(data);
	}

	resize(cols: number, rows: number): void {
		if (this.destroyed) return;
		this.cols = cols;
		this.rows = rows;
		try {
			execFileSync(
				TMUX_CMD,
				[
					"resize-pane",
					"-t",
					this.paneTarget,
					"-x",
					String(cols),
					"-y",
					String(rows),
				],
				{ timeout: 2000 },
			);
		} catch {
			// Pane may no longer exist
		}
	}

	kill(signal?: string): void {
		if (this.destroyed) return;
		this.destroy();

		if (signal === "SIGKILL") {
			// Force kill the pane
			try {
				execFileSync(TMUX_CMD, ["kill-pane", "-t", this.paneTarget], {
					timeout: 2000,
				});
			} catch {
				// Already dead
			}
		} else {
			// Graceful: send Ctrl+C then wait
			try {
				execFileSync(TMUX_CMD, ["send-keys", "-t", this.paneTarget, "C-c"], {
					timeout: 2000,
				});
			} catch {
				// Already dead
			}
		}
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
	}

	clear(): void {
		// no-op for tmux panes
	}

	// ── Public helpers ──

	/** Capture current screen content with ANSI escapes (for initial attach) */
	captureScreen(): string {
		try {
			return execFileSync(
				TMUX_CMD,
				["capture-pane", "-t", this.paneTarget, "-p", "-e"],
				{ encoding: "utf-8", timeout: 2000 },
			);
		} catch {
			return "";
		}
	}

	/** Check if the tmux pane still exists */
	isAlive(): boolean {
		try {
			execFileSync(
				TMUX_CMD,
				["display-message", "-t", this.paneTarget, "-p", "#{pane_id}"],
				{ encoding: "utf-8", timeout: 1000 },
			);
			return true;
		} catch {
			return false;
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;

		// Kill tail process
		if (this.tailProcess) {
			this.tailProcess.kill("SIGTERM");
			this.tailProcess = null;
		}

		// Stop pipe-pane
		try {
			execFileSync(TMUX_CMD, ["pipe-pane", "-t", this.paneTarget], {
				timeout: 2000,
			});
		} catch {
			// Pane may not exist
		}

		// Clean up pipe file
		try {
			if (existsSync(this.pipePath)) unlinkSync(this.pipePath);
		} catch {
			// Best effort
		}

		// Fire exit callbacks
		for (const cb of this.exitCallbacks) {
			try {
				cb({ exitCode: 0 });
			} catch {
				// Ignore callback errors
			}
		}
	}

	// ── Internals ──

	private startOutputPipe(): void {
		// Ensure pipe directory exists
		try {
			execFileSync("mkdir", ["-p", PIPE_DIR], { timeout: 1000 });
		} catch {
			// Ignore
		}

		// Create empty file for output
		writeFileSync(this.pipePath, "");

		// Start pipe-pane: tmux pipes raw program output to our file.
		// Shell-quote the path to prevent injection — pipe-pane runs via sh -c.
		const safePath = this.pipePath.replace(/'/g, "'\\''");
		try {
			execFileSync(
				TMUX_CMD,
				["pipe-pane", "-O", "-t", this.paneTarget, `cat >> '${safePath}'`],
				{ timeout: 2000 },
			);
		} catch (e) {
			console.error(
				`[TmuxPty] Failed to start pipe-pane for ${this.paneTarget}:`,
				(e as Error).message,
			);
			return;
		}

		// Tail the file for real-time output
		this.tailProcess = spawn("tail", ["-f", "-c", "+0", this.pipePath], {
			stdio: ["ignore", "pipe", "ignore"],
		});

		this.tailProcess.stdout?.on("data", (chunk: Buffer) => {
			if (this.paused || this.destroyed) return;
			const data = chunk.toString("utf-8");
			for (const cb of this.dataCallbacks) {
				try {
					cb(data);
				} catch {
					// Ignore callback errors
				}
			}
		});

		this.tailProcess.on("exit", (code) => {
			console.log(
				`[TmuxPty] tail exited for ${this.paneTarget} code=${code} destroyed=${this.destroyed}`,
			);
			if (!this.destroyed) {
				this.destroy();
			}
		});

		this.tailProcess.on("error", (err) => {
			console.error(
				`[TmuxPty] tail error for ${this.paneTarget}:`,
				err.message,
			);
		});

		// Monitor pane liveness every 5s
		const livenessInterval = setInterval(() => {
			if (this.destroyed) {
				clearInterval(livenessInterval);
				return;
			}
			if (!this.isAlive()) {
				clearInterval(livenessInterval);
				this.destroy();
			}
		}, 5000);
	}

	private tmuxSendKey(keyName: string): void {
		try {
			execFileSync(TMUX_CMD, ["send-keys", "-t", this.paneTarget, keyName], {
				timeout: 1000,
			});
		} catch {
			// Pane may not exist
		}
	}

	private tmuxSendLiteral(text: string): void {
		try {
			execFileSync(
				TMUX_CMD,
				["send-keys", "-t", this.paneTarget, "-l", "--", text],
				{ timeout: 1000 },
			);
		} catch {
			// Pane may not exist
		}
	}

	private readPanePid(): number {
		try {
			const out = execFileSync(
				TMUX_CMD,
				["display-message", "-t", this.paneTarget, "-p", "#{pane_pid}"],
				{ encoding: "utf-8", timeout: 1000 },
			).trim();
			return parseInt(out, 10) || 0;
		} catch {
			return 0;
		}
	}
}
