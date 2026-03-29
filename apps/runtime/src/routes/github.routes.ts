import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { spawnSync } from "child_process";
import { getGitStatus, startGitHubFullLogin } from "../services/git.js";
import { invalidateGhAuthCache } from "../services/git/github-auth.js";
import { broadcastStatus } from "../web/websocket.js";

const router = Router();

// GitHub login status
let ghLoginState = {
	inProgress: false,
	code: null as string | null,
	url: null as string | null,
	success: false,
};

// Start full GitHub login (gh auth login)
router.post("/login", asyncHandler(async (_req, res) => {
	if (ghLoginState.inProgress) {
		res.json({
			started: false,
			message: "Login already in progress",
			code: ghLoginState.code,
			url: ghLoginState.url,
		});
		return;
	}

	ghLoginState = { inProgress: true, code: null, url: null, success: false };
	res.json({ started: true, message: "GitHub login started" });

	const success = await startGitHubFullLogin({
		onCode: (code) => {
			ghLoginState.code = code;
			broadcastStatus();
		},
		onUrl: (url) => {
			ghLoginState.url = url;
			broadcastStatus();
		},
		onSuccess: () => {
			ghLoginState.success = true;
			ghLoginState.inProgress = false;
			broadcastStatus();
		},
		onError: () => {
			ghLoginState.inProgress = false;
			broadcastStatus();
		},
	});

	ghLoginState.inProgress = false;
	ghLoginState.success = success;
	broadcastStatus();
}));

// GitHub login status
router.get("/login-status", (_req, res) => {
	const gitStatus = getGitStatus();
	res.json({
		inProgress: ghLoginState.inProgress,
		// Only expose code/url while login is in progress — prevents leaking stale device codes
		code: ghLoginState.inProgress ? ghLoginState.code : null,
		url: ghLoginState.inProgress ? ghLoginState.url : null,
		success: ghLoginState.success,
		authenticated: gitStatus.github.authenticated,
		mode: gitStatus.github.mode,
		username: gitStatus.github.username,
		email: gitStatus.github.email,
		avatarUrl: gitStatus.github.avatarUrl,
	});
});

// GitHub logout (gh auth logout)
router.post("/logout", (_req, res) => {
	try {
		spawnSync("gh", ["auth", "logout", "--hostname", "github.com"], {
			timeout: 10_000,
			input: "Y\n",
			stdio: ["pipe", "pipe", "pipe"],
		});
		invalidateGhAuthCache();
		broadcastStatus();
		res.json({ success: true });
	} catch {
		res.json({ success: false, error: "Logout failed" });
	}
});

export default router;
