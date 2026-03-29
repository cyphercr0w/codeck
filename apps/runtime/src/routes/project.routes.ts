import { Router } from "express";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import {
	updateClaudeMd,
	isValidGitUrl,
	checkDiskSpace,
} from "../services/git.js";
import { broadcast } from "../web/logger.js";
import { broadcastStatus } from "../web/websocket.js";
import { asyncHandler } from "../utils/async-handler.js";

const CLONE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SIGKILL_GRACE_MS = 5000;

const WORKSPACE = resolve(process.env.WORKSPACE || "/workspace");
const router = Router();

// Create a new empty project directory
router.post(
	"/create",
	asyncHandler(async (req, res) => {
		const { name } = req.body;
		if (!name || typeof name !== "string") {
			res.status(400).json({ error: "name is required" });
			return;
		}

		const sanitized = name
			.replace(/[^a-zA-Z0-9_\-. ]/g, "")
			.replace(/^\.+/, "")
			.trim();
		if (!sanitized) {
			res.status(400).json({
				error:
					"Project name can only contain letters, numbers, spaces, dots, hyphens, and underscores",
			});
			return;
		}
		if (sanitized.length > 100) {
			res
				.status(400)
				.json({ error: "Project name must be 100 characters or less" });
			return;
		}

		const fullPath = join(WORKSPACE, sanitized);

		try {
			// Atomic: mkdir with recursive:false throws EEXIST if directory exists
			await mkdir(fullPath, { recursive: false });
			broadcastStatus();
			res.json({ success: true, path: fullPath, name: sanitized });
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				res.status(409).json({ error: "Directory already exists" });
			} else {
				res.status(500).json({ error: "Failed to create directory" });
			}
		}
	}),
);

// Clone a repository
router.post(
	"/clone",
	asyncHandler(async (req, res) => {
		const { url, name, branch } = req.body;
		if (!url || typeof url !== "string") {
			res.status(400).json({ error: "url is required" });
			return;
		}

		// Validate URL (SSRF, CRLF, protocol checks)
		if (!isValidGitUrl(url)) {
			res.status(400).json({ error: "Invalid repository URL" });
			return;
		}

		// Validate branch name — only allow safe characters (no flag injection)
		if (
			branch &&
			(typeof branch !== "string" || !/^[\w\-.\/]+$/.test(branch))
		) {
			res.status(400).json({ error: "Invalid branch name" });
			return;
		}

		// Extract repo name from URL if not provided
		const repoName = name || extractRepoName(url);
		const sanitized = repoName.replace(/[^a-zA-Z0-9_\-. ]/g, "").trim();
		if (!sanitized || sanitized.length > 100) {
			res.status(400).json({
				error: !sanitized
					? "Could not determine project name"
					: "Project name too long (max 100)",
			});
			return;
		}

		const targetPath = join(WORKSPACE, sanitized);

		// Atomic claim: create directory to prevent concurrent clones to same path
		try {
			await mkdir(targetPath, { recursive: false });
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				res
					.status(409)
					.json({ error: `Directory "${sanitized}" already exists` });
			} else {
				res.status(500).json({ error: "Failed to prepare clone target" });
			}
			return;
		}

		async function removePartialClone(): Promise<void> {
			if (existsSync(targetPath)) {
				await rm(targetPath, { recursive: true, force: true });
			}
		}

		// Pre-flight disk space check
		const diskError = checkDiskSpace(WORKSPACE);
		if (diskError) {
			await removePartialClone();
			res.status(507).json({ success: false, error: diskError });
			return;
		}

		console.log(
			`[Project] Cloning ${url} → ${sanitized}${branch ? ` (branch: ${branch})` : ""}`,
		);

		const args = ["clone"];
		if (branch) args.push("--branch", branch);
		args.push("--", url, sanitized);

		const proc = spawn("git", args, {
			cwd: WORKSPACE,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;

		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			console.log(
				`[Project] Clone timeout after ${CLONE_TIMEOUT_MS / 1000}s, sending SIGTERM`,
			);
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (proc.exitCode === null) {
					console.log("[Project] Escalating to SIGKILL");
					proc.kill("SIGKILL");
				}
			}, SIGKILL_GRACE_MS);
		}, CLONE_TIMEOUT_MS);

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			stderr += chunk;
			// Git outputs progress to stderr — broadcast each line for real-time UI
			const lines = chunk.split(/\r?\n|\r/).filter((l: string) => l.trim());
			for (const line of lines) {
				broadcast({
					type: "clone:progress",
					line: line.trim(),
					target: sanitized,
				});
			}
		});

		proc.on("close", async (code) => {
			clearTimeout(timeoutHandle);
			if (killTimer) clearTimeout(killTimer);

			if (timedOut) {
				await removePartialClone();
				res.status(504).json({
					success: false,
					error: "Clone timed out (exceeded 10 minutes)",
				});
				return;
			}

			if (code === 0) {
				console.log(`[Project] ✓ Cloned ${sanitized}`);
				updateClaudeMd();
				broadcastStatus();
				res.json({
					success: true,
					path: targetPath,
					name: sanitized,
					output: stdout + stderr,
				});
			} else {
				console.log(`[Project] ✗ Clone failed: ${stderr}`);
				await removePartialClone();
				res.status(500).json({
					success: false,
					error: stderr.trim() || "Clone failed",
					output: stdout + stderr,
				});
			}
		});

		proc.on("error", async (err) => {
			clearTimeout(timeoutHandle);
			if (killTimer) clearTimeout(killTimer);
			await removePartialClone();
			res.status(500).json({ success: false, error: err.message });
		});
	}),
);

function extractRepoName(url: string): string {
	const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
	return match ? match[1] : "repo";
}

export default router;
