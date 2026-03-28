import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../api";
import { showToast } from "../state/store";
import {
	IconKey,
	IconGithub,
	IconCopy,
	IconCheck,
	IconRefresh,
	IconX,
	IconChevronLeft,
	IconPlug,
	IconSupabase,
	IconVercel,
	IconStripe,
	IconNotion,
	IconGoogle,
	IconCloudflare,
	IconFigma,
} from "./Icons";

// ── Types ──

interface SSHStatus {
	hasKey: boolean;
	publicKey: string | null;
	authenticated: boolean;
}

interface GitHubStatus {
	authenticated: boolean;
	loginInProgress: boolean;
	code: string | null;
	url: string | null;
	username: string | null;
	email: string | null;
	avatarUrl: string | null;
}

// ── Integration Registry ──

interface IntegrationDef {
	id: string;
	name: string;
	description: string;
	icon: () => preact.JSX.Element;
	available: boolean;
	// For token-based integrations
	tokenBased?: boolean;
	tokenEnvKey?: string;
	tokenUrl?: string;
	tokenHint?: string;
	mcpServerName?: string;
	mcpCommand?: string;
	mcpArgs?: string[];
	// For CLI-based OAuth (device flow)
	cliAuth?: boolean;
	cliAuthService?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
	{
		id: "github",
		name: "GitHub",
		description: "Repos, PRs, issues, and code search",
		icon: () => <IconGithub size={22} />,
		available: true,
		mcpServerName: "github",
	},
	{
		id: "supabase",
		name: "Supabase",
		description: "Database, auth, storage, and edge functions",
		icon: () => <IconSupabase size={22} />,
		available: true,
		tokenBased: true,
		tokenEnvKey: "SUPABASE_ACCESS_TOKEN",
		tokenUrl: "https://supabase.com/dashboard/account/tokens",
		tokenHint: "Generate a token at supabase.com → Account → Access Tokens",
		mcpServerName: "supabase",
		mcpCommand: "npx",
		mcpArgs: ["-y", "@supabase/mcp-server-supabase"],
	},
	{
		id: "vercel",
		name: "Vercel",
		description: "Deployments, projects, and domains",
		icon: () => <IconVercel size={22} />,
		available: true,
		tokenBased: true,
		tokenEnvKey: "VERCEL_TOKEN",
		tokenUrl: "https://vercel.com/account/tokens",
		tokenHint: "Generate a token at vercel.com → Account → Tokens",
		mcpServerName: "vercel",
		mcpCommand: "npx",
		mcpArgs: ["-y", "vercel-mcp@latest"],
	},
	{
		id: "stripe",
		name: "Stripe",
		description: "Payments, subscriptions, and invoices",
		icon: () => <IconStripe size={22} />,
		available: true,
		tokenBased: true,
		tokenEnvKey: "STRIPE_SECRET_KEY",
		tokenUrl: "https://dashboard.stripe.com/apikeys",
		tokenHint: "Copy your Secret Key from the Stripe Dashboard → API Keys",
		mcpServerName: "stripe",
		mcpCommand: "npx",
		mcpArgs: ["-y", "@stripe/mcp"],
	},
	{
		id: "notion",
		name: "Notion",
		description: "Pages, databases, and workspaces",
		icon: () => <IconNotion size={22} />,
		available: true,
		tokenBased: true,
		tokenEnvKey: "NOTION_API_KEY",
		tokenUrl: "https://www.notion.so/my-integrations",
		tokenHint:
			"Create an integration at notion.so/my-integrations and copy the secret",
		mcpServerName: "notion",
		mcpCommand: "npx",
		mcpArgs: ["-y", "@notionhq/mcp-server-notion"],
	},
	{
		id: "google",
		name: "Google (Gmail, Drive, Sheets)",
		description: "Email, documents, spreadsheets, and calendar",
		icon: () => <IconGoogle size={22} />,
		available: true,
		tokenBased: true,
		tokenEnvKey: "GOOGLE_API_KEY",
		tokenUrl: "https://console.cloud.google.com/apis/credentials",
		tokenHint:
			"Create an API key or Service Account at Google Cloud Console → APIs & Services → Credentials",
		mcpServerName: "google",
	},
	{
		id: "cloudflare",
		name: "Cloudflare",
		description: "DNS, Workers, Pages, and CDN",
		icon: () => <IconCloudflare size={22} />,
		available: true,
		tokenBased: true,
		tokenEnvKey: "CLOUDFLARE_API_TOKEN",
		tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
		tokenHint:
			"Create an API token at Cloudflare Dashboard → Profile → API Tokens",
		mcpServerName: "cloudflare",
		mcpCommand: "npx",
		mcpArgs: ["-y", "@cloudflare/mcp-server-cloudflare"],
	},
	{
		id: "figma",
		name: "Figma",
		description: "Design files, components, and styles",
		icon: () => <IconFigma size={22} />,
		available: true,
		tokenBased: true,
		tokenEnvKey: "FIGMA_ACCESS_TOKEN",
		tokenUrl: "https://www.figma.com/developers/api#access-tokens",
		tokenHint:
			"Generate a personal access token at Figma → Settings → Personal Access Tokens",
		mcpServerName: "figma",
		mcpCommand: "npx",
		mcpArgs: ["-y", "figma-developer-mcp"],
	},
];

// ── Token-Based Integration Detail ──

function CLIAuthSection({
	service,
	name,
	onSuccess,
}: {
	service: string;
	name: string;
	onSuccess: () => void;
}) {
	const [authState, setAuthState] = useState<{
		inProgress: boolean;
		code: string | null;
		url: string | null;
		success: boolean;
		error: string | null;
	}>({ inProgress: false, code: null, url: null, success: false, error: null });
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);

	async function startLogin() {
		// Clear any existing poll before starting a new one
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}

		try {
			const res = await apiFetch(`/api/cli-auth/${service}/login`, {
				method: "POST",
			});
			const data = await res.json();
			setAuthState(data);

			if (data.inProgress) {
				pollRef.current = setInterval(async () => {
					try {
						const r = await apiFetch(`/api/cli-auth/${service}/status`);
						const d = await r.json();
						setAuthState(d);
						if (d.success) {
							if (pollRef.current) clearInterval(pollRef.current);
							pollRef.current = null;
							onSuccess();
						}
						if (!d.inProgress && !d.success) {
							if (pollRef.current) clearInterval(pollRef.current);
							pollRef.current = null;
						}
					} catch {
						/* transient — retry next interval */
					}
				}, 2000);
			}
		} catch {
			setAuthState((prev) => ({
				...prev,
				inProgress: false,
				error: "Failed to start login",
			}));
		}
	}

	if (authState.success) {
		return (
			<div class="integ-section-info" style="color: var(--success)">
				Authenticated with {name}!
			</div>
		);
	}

	if (authState.inProgress && authState.url) {
		return (
			<div class="integ-cli-auth">
				<p class="integ-section-info">
					Visit the link below and authorize access:
				</p>
				<a
					href={authState.url}
					target="_blank"
					rel="noopener noreferrer"
					class="btn btn-sm btn-primary"
					style="display: inline-flex; margin: 8px 0"
				>
					Open {name} Authorization →
				</a>
				{authState.code && (
					<p
						class="integ-section-info"
						style="font-family: var(--font-mono); font-size: 18px; letter-spacing: 2px; margin-top: 4px"
					>
						Code: <strong>{authState.code}</strong>
					</p>
				)}
				<p class="integ-section-info" style="color: var(--text-muted)">
					<span class="spinner-sm" style="margin-right: 6px" /> Waiting for
					authorization...
				</p>
			</div>
		);
	}

	return (
		<button
			class="btn btn-sm btn-primary"
			onClick={startLogin}
			disabled={authState.inProgress}
			style="width: 100%"
		>
			{authState.inProgress ? (
				<span class="spinner-sm" />
			) : (
				`Sign in with ${name}`
			)}
		</button>
	);
}

function TokenIntegrationDetail({
	integ,
	onBack,
}: {
	integ: IntegrationDef;
	onBack: () => void;
}) {
	const [token, setToken] = useState("");
	const [connected, setConnected] = useState(false);
	const [saving, setSaving] = useState(false);
	const [checking, setChecking] = useState(true);
	const [accountInfo, setAccountInfo] = useState<{
		username?: string;
		email?: string;
		team?: string;
	} | null>(null);

	// Check if already connected (env var exists) and fetch account info
	useEffect(() => {
		setChecking(true);
		apiFetch("/api/codeck/env")
			.then((r) => r.json())
			.then((data) => {
				const vars = data.vars || [];
				const isConnected = vars.some(
					(v: { key: string; hasValue: boolean }) =>
						v.key === integ.tokenEnvKey && v.hasValue,
				);
				setConnected(isConnected);
				if (isConnected && integ.tokenEnvKey) {
					apiFetch(`/api/codeck/integration/${integ.tokenEnvKey}/account`)
						.then((r) => r.json())
						.then((info) => {
							if (info.connected) setAccountInfo(info);
						})
						.catch(() => {});
				}
			})
			.catch((err: unknown) => {
				console.error("Failed to check integration status:", err);
				showToast("Could not load integration details", "error");
			})
			.finally(() => setChecking(false));
	}, [integ.tokenEnvKey]);

	async function handleConnect() {
		if (!token.trim()) return;
		setSaving(true);
		try {
			// Save token as env var
			const envRes = await apiFetch("/api/codeck/env", {
				method: "POST",
				body: JSON.stringify({ key: integ.tokenEnvKey, value: token.trim() }),
			});
			const envData = await envRes.json();
			if (!envData.success) {
				showToast(envData.error || "Failed to save token", "error");
				setSaving(false);
				return;
			}

			// Create or enable the MCP server
			if (integ.mcpServerName && integ.mcpCommand) {
				try {
					// Check current MCP servers
					const mcpRes = await apiFetch("/api/mcp-servers");
					const mcpData = await mcpRes.json();
					const servers = mcpData.servers || [];
					const server = servers.find(
						(s: { name: string }) => s.name === integ.mcpServerName,
					);

					if (server && !server.enabled) {
						// Server exists but is disabled — enable it
						await apiFetch(
							`/api/mcp-servers/${encodeURIComponent(integ.mcpServerName!)}/toggle`,
							{ method: "POST" },
						);
					} else if (!server) {
						// Server doesn't exist — create it with the correct command and env mapping
						const env: Record<string, string> = {};
						if (integ.tokenEnvKey) {
							env[integ.tokenEnvKey] = token.trim();
						}
						await apiFetch("/api/mcp-servers", {
							method: "POST",
							body: JSON.stringify({
								name: integ.mcpServerName,
								command: integ.mcpCommand,
								args: integ.mcpArgs || [],
								env,
							}),
						});
					}
				} catch {
					/* MCP setup is best-effort */
				}
			}

			setConnected(true);
			setToken("");
			showToast(
				`${integ.name} connected! Open a new terminal to use it.`,
				"success",
				5000,
			);
			// Fetch account info
			if (integ.tokenEnvKey) {
				apiFetch(`/api/codeck/integration/${integ.tokenEnvKey}/account`)
					.then((r) => r.json())
					.then((info) => {
						if (info.connected) setAccountInfo(info);
					})
					.catch(() => {});
			}
		} catch {
			showToast("Connection error", "error");
		}
		setSaving(false);
	}

	async function handleDisconnect() {
		try {
			// Remove env var
			await apiFetch("/api/codeck/env", {
				method: "DELETE",
				body: JSON.stringify({ key: integ.tokenEnvKey }),
			});

			// Disable MCP server
			if (integ.mcpServerName) {
				try {
					const mcpRes = await apiFetch("/api/mcp-servers");
					const mcpData = await mcpRes.json();
					const server = (mcpData.servers || []).find(
						(s: { name: string; enabled: boolean }) =>
							s.name === integ.mcpServerName && s.enabled,
					);
					if (server) {
						await apiFetch(
							`/api/mcp-servers/${encodeURIComponent(integ.mcpServerName!)}/toggle`,
							{ method: "POST" },
						);
					}
				} catch {
					/* best-effort */
				}
			}

			setConnected(false);
			showToast(`${integ.name} disconnected`, "success");
		} catch {
			showToast("Failed to disconnect", "error");
		}
	}

	return (
		<div class="integ-detail">
			<div class="integ-detail-topbar">
				<button class="btn btn-xs btn-ghost" onClick={onBack}>
					<IconChevronLeft size={12} /> Integrations
				</button>
				{connected && (
					<button
						class="btn btn-xs btn-ghost danger"
						onClick={handleDisconnect}
					>
						<IconX size={11} /> Disconnect
					</button>
				)}
			</div>

			<div class="integ-detail-header">
				<div class="integ-detail-icon">{integ.icon()}</div>
				<div style="flex: 1">
					<h3 class="integ-detail-name">{integ.name}</h3>
					<p class="integ-detail-desc">{integ.description}</p>
				</div>
				<span class={`badge ${connected ? "badge-success" : "badge-muted"}`}>
					{checking ? "Checking..." : connected ? "Connected" : "Not connected"}
				</span>
			</div>

			{/* One-click auth via CLI device flow */}
			{integ.cliAuth && integ.cliAuthService && !connected && (
				<div class="integ-section">
					<div class="integ-section-header">
						<IconPlug size={14} />
						<span>Sign In</span>
					</div>
					<div class="integ-section-body">
						<CLIAuthSection
							service={integ.cliAuthService}
							name={integ.name}
							onSuccess={() => {
								setConnected(true);
								showToast(`${integ.name} connected!`, "success");
							}}
						/>
					</div>
				</div>
			)}

			<div class="integ-section">
				<div class="integ-section-header">
					<IconKey size={14} />
					<span>
						{integ.cliAuth && !connected ? "Or use API Token" : "API Token"}
					</span>
				</div>

				<div class="integ-section-body">
					{connected ? (
						<div class="integ-connected-info">
							{accountInfo ? (
								<div class="integ-account-details">
									{accountInfo.username && (
										<div class="integ-account-row">
											<span class="integ-account-label">Account</span>
											<span class="integ-account-value">
												{accountInfo.username}
											</span>
										</div>
									)}
									{accountInfo.email && (
										<div class="integ-account-row">
											<span class="integ-account-label">Email</span>
											<span class="integ-account-value">
												{accountInfo.email}
											</span>
										</div>
									)}
									{accountInfo.team && (
										<div class="integ-account-row">
											<span class="integ-account-label">Name</span>
											<span class="integ-account-value">
												{accountInfo.team}
											</span>
										</div>
									)}
								</div>
							) : (
								<p class="integ-section-info">
									{integ.name} is connected and ready to use.
								</p>
							)}
						</div>
					) : (
						<>
							<p class="integ-section-info">{integ.tokenHint}</p>
							{integ.tokenUrl && (
								<p class="integ-section-info">
									<a
										href={integ.tokenUrl}
										target="_blank"
										rel="noopener noreferrer"
										style="color: var(--accent)"
									>
										Open {integ.name} Dashboard →
									</a>
								</p>
							)}
							<div style="display: flex; gap: 8px; margin-top: 8px">
								<input
									class="input"
									type="text"
									placeholder={`Paste your ${integ.name} token`}
									value={token}
									onInput={(e) =>
										setToken((e.target as HTMLInputElement).value)
									}
									onKeyDown={(e) => e.key === "Enter" && handleConnect()}
									style="flex: 1; -webkit-text-security: disc"
									autocomplete="off"
									data-1p-ignore
									data-lpignore="true"
								/>
								<button
									class="btn btn-sm btn-primary"
									onClick={handleConnect}
									disabled={saving || !token.trim()}
								>
									{saving ? <span class="spinner-sm" /> : "Connect"}
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

// ── GitHub Detail ──

function GitHubDetail({ onBack }: { onBack: () => void }) {
	const [ssh, setSSH] = useState<SSHStatus>({
		hasKey: false,
		publicKey: null,
		authenticated: false,
	});
	const [github, setGitHub] = useState<GitHubStatus>({
		authenticated: false,
		loginInProgress: false,
		code: null,
		url: null,
		username: null,
		email: null,
		avatarUrl: null,
	});
	const [generating, setGenerating] = useState(false);
	const [testing, setTesting] = useState(false);
	const [ghConnecting, setGhConnecting] = useState(false);
	const [copied, setCopied] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		loadSSH();
		loadGitHub();
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);

	async function loadSSH() {
		try {
			const res = await apiFetch("/api/ssh/status");
			const data = await res.json();
			setSSH({
				hasKey: data.hasKey || false,
				publicKey: data.publicKey || null,
				authenticated: data.authenticated || false,
			});
		} catch (err) {
			console.error("Failed to load SSH status:", err);
			showToast("Could not load SSH status", "error");
		}
	}

	async function loadGitHub() {
		try {
			const res = await apiFetch("/api/github/login-status");
			const data = await res.json();
			setGitHub(data);
		} catch (err) {
			console.error("Failed to load GitHub status:", err);
			showToast("Could not load GitHub status", "error");
		}
	}

	async function handleGenerate(force = false) {
		setGenerating(true);
		try {
			const res = await apiFetch("/api/ssh/generate", {
				method: "POST",
				body: JSON.stringify({ force }),
			});
			const data = await res.json();
			if (data.success) {
				showToast("SSH key generated", "success");
				loadSSH();
			} else {
				showToast(data.error || "Generation failed", "error");
			}
		} catch {
			showToast("Error generating key", "error");
		}
		setGenerating(false);
	}

	async function handleTest() {
		setTesting(true);
		try {
			const res = await apiFetch("/api/ssh/test");
			const data = await res.json();
			if (data.authenticated) {
				setSSH((prev) => ({ ...prev, authenticated: true }));
				showToast("SSH connection successful", "success");
			} else {
				showToast("SSH test failed — add key to GitHub first", "error");
			}
		} catch {
			showToast("Test failed", "error");
		}
		setTesting(false);
	}

	async function handleCopy() {
		if (!ssh.publicKey) return;
		try {
			await navigator.clipboard.writeText(ssh.publicKey);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			showToast("Could not copy to clipboard", "error");
		}
	}

	async function handleGitHubLogin() {
		setGhConnecting(true);
		try {
			const res = await apiFetch("/api/github/login", { method: "POST" });
			const data = await res.json();
			if (data.started || data.code) {
				setGitHub((prev) => ({
					...prev,
					loginInProgress: true,
					code: data.code ?? prev.code,
					url: data.url ?? prev.url,
				}));
				// Poll for completion — the code/url arrive asynchronously via status endpoint
				if (pollRef.current) clearInterval(pollRef.current);
				pollRef.current = setInterval(async () => {
					try {
						const r = await apiFetch("/api/github/login-status");
						const d = await r.json();
						// Update code/url as they become available
						if (d.code || d.url) {
							setGitHub((prev) => ({
								...prev,
								code: d.code ?? prev.code,
								url: d.url ?? prev.url,
							}));
						}
						if (d.authenticated) {
							if (pollRef.current) clearInterval(pollRef.current);
							setGitHub(d);
							setGhConnecting(false);
						} else if (!d.inProgress && !d.authenticated) {
							// Login finished without success
							if (pollRef.current) clearInterval(pollRef.current);
							setGhConnecting(false);
							showToast("GitHub login failed or timed out", "error");
						}
					} catch {
						/* retry */
					}
				}, 2000);
			}
		} catch (err) {
			console.error("GitHub login failed:", err);
			showToast("Could not connect to GitHub", "error");
			setGhConnecting(false);
		}
	}

	async function handleDisconnect() {
		try {
			await apiFetch("/api/github/logout", { method: "POST" });
			setGitHub((prev) => ({
				...prev,
				authenticated: false,
				username: null,
				email: null,
			}));
			showToast("GitHub disconnected", "success");
		} catch {
			showToast("Failed to disconnect", "error");
		}
	}

	return (
		<div class="integ-detail">
			<div class="integ-detail-topbar">
				<button class="btn btn-xs btn-ghost" onClick={onBack}>
					<IconChevronLeft size={12} /> Integrations
				</button>
				{github.authenticated && (
					<button
						class="btn btn-xs btn-ghost danger"
						onClick={handleDisconnect}
					>
						<IconX size={11} /> Disconnect
					</button>
				)}
			</div>

			<div class="integ-detail-header">
				<div class="integ-detail-icon">
					<IconGithub size={28} />
				</div>
				<div style="flex: 1">
					<h3 class="integ-detail-name">GitHub</h3>
					<p class="integ-detail-desc">
						SSH keys and account authentication for repositories
					</p>
				</div>
				<span
					class={`badge ${github.authenticated ? "badge-success" : "badge-muted"}`}
				>
					{github.authenticated ? "Connected" : "Not connected"}
				</span>
			</div>

			{/* SSH Section */}
			<div class="integ-section">
				<div class="integ-section-header">
					<IconKey size={14} />
					<span>SSH Key</span>
					<span
						class={`badge ${ssh.hasKey ? (ssh.authenticated ? "badge-success" : "badge-info") : "badge-muted"}`}
					>
						{ssh.hasKey
							? ssh.authenticated
								? "Verified"
								: "Key exists"
							: "No key"}
					</span>
				</div>

				<div class="integ-section-body">
					{ssh.hasKey ? (
						<>
							<div class="integ-pubkey-box">
								<code class="integ-pubkey">{ssh.publicKey || "..."}</code>
								<button
									class="btn btn-xs btn-ghost"
									onClick={handleCopy}
									title="Copy"
								>
									{copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
								</button>
							</div>
							<p class="integ-section-hint">
								Add this key at{" "}
								<a
									href="https://github.com/settings/keys"
									target="_blank"
									rel="noopener noreferrer"
								>
									github.com/settings/keys
								</a>
							</p>
							<div class="integ-actions">
								<button
									class="btn btn-xs btn-secondary"
									onClick={handleTest}
									disabled={testing}
								>
									{testing ? (
										<span class="spinner-sm" />
									) : (
										<IconRefresh size={11} />
									)}
									Test Connection
								</button>
								<button
									class="btn btn-xs btn-ghost"
									onClick={() => handleGenerate(true)}
									disabled={generating}
								>
									Regenerate
								</button>
							</div>
						</>
					) : (
						<>
							<p class="integ-section-info">
								Generate an SSH key to clone repos via SSH.
							</p>
							<button
								class="btn btn-sm btn-primary"
								onClick={() => handleGenerate(false)}
								disabled={generating}
							>
								{generating ? (
									<span class="spinner-sm" />
								) : (
									<IconKey size={13} />
								)}
								Generate SSH Key
							</button>
						</>
					)}
				</div>
			</div>

			{/* HTTPS Section */}
			<div class="integ-section">
				<div class="integ-section-header">
					<IconGithub size={14} />
					<span>Connect via HTTPS</span>
					<span
						class={`badge ${github.authenticated ? "badge-success" : "badge-muted"}`}
					>
						{github.authenticated ? "Authenticated" : "Not connected"}
					</span>
				</div>

				<div class="integ-section-body">
					{github.loginInProgress ? (
						<div class="integ-login-flow">
							<p class="integ-section-info">
								Open{" "}
								<a
									href={github.url || "https://github.com/login/device"}
									target="_blank"
									rel="noopener noreferrer"
								>
									github.com/login/device
								</a>{" "}
								and enter the code:
							</p>
							<div class="integ-device-code">{github.code || "..."}</div>
							<p class="integ-section-hint">
								Only enter this code if you initiated this login yourself.
							</p>
							<div class="integ-waiting">
								<span class="spinner-sm" /> Waiting for authentication...
							</div>
						</div>
					) : github.authenticated ? (
						<div class="integ-connected-info">
							{github.username && (
								<span class="integ-username">@{github.username}</span>
							)}
							{github.email && <span class="integ-email">{github.email}</span>}
							<p class="integ-section-hint">
								Clone private repos via HTTPS using GitHub CLI.
							</p>
						</div>
					) : (
						<>
							<p class="integ-section-info">
								Connect your GitHub account to access private repos via HTTPS.
							</p>
							<button
								class="btn btn-sm btn-primary"
								onClick={handleGitHubLogin}
								disabled={ghConnecting}
							>
								{ghConnecting ? (
									<span class="spinner-sm" />
								) : (
									<IconGithub size={13} />
								)}
								{ghConnecting ? "Connecting..." : "Connect GitHub"}
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Main Component ──

interface ConnectedAccount {
	connected: boolean;
	email?: string | null;
	username?: string | null;
}

export function IntegrationsSection() {
	const [selected, setSelected] = useState<string | null>(null);
	const [accounts, setAccounts] = useState<Record<string, ConnectedAccount>>(
		{},
	);
	const [loading, setLoading] = useState(true);

	// Check which services are connected (cached — only re-fetch on mount or force)
	const lastChecked = useRef(0);
	const CACHE_TTL = 3 * 60 * 1000; // 3 min

	useEffect(() => {
		const now = Date.now();
		if (
			selected === null &&
			lastChecked.current > 0 &&
			now - lastChecked.current < CACHE_TTL
		) {
			return;
		}
		if (selected !== null) return;

		async function checkConnections() {
			setLoading(true);
			const result: Record<string, ConnectedAccount> = {};
			let hadError = false;

			// GitHub — has full account info
			try {
				const ghRes = await apiFetch("/api/github/login-status");
				const ghData = await ghRes.json();
				result.github = {
					connected: !!ghData.authenticated,
					email: ghData.email,
					username: ghData.username,
				};
			} catch (err) {
				console.error("Failed to check GitHub status:", err);
				hadError = true;
			}

			// Token-based services via env vars
			try {
				const envRes = await apiFetch("/api/codeck/env");
				const envData = await envRes.json();
				const vars = new Map<string, boolean>();
				for (const v of envData.vars || []) {
					if (v.hasValue) vars.set(v.key, true);
				}

				for (const integ of INTEGRATIONS) {
					if (integ.tokenEnvKey && vars.has(integ.tokenEnvKey)) {
						result[integ.id] = { connected: true };
					}
				}
			} catch (err) {
				console.error("Failed to check integrations:", err);
				hadError = true;
			}

			if (hadError) showToast("Could not load integrations", "error");

			// CLI-auth services (e.g. Vercel via device flow) — check if still authenticated
			for (const integ of INTEGRATIONS) {
				if (
					integ.cliAuth &&
					integ.cliAuthService &&
					!result[integ.id]?.connected
				) {
					try {
						const cliRes = await apiFetch(
							`/api/cli-auth/${integ.cliAuthService}/authenticated`,
						);
						const cliData = await cliRes.json();
						if (cliData.authenticated) {
							result[integ.id] = {
								connected: true,
								username: cliData.username,
							};
						}
					} catch {
						/* ignore */
					}
				}
			}

			setAccounts(result);
			lastChecked.current = Date.now();
			setLoading(false);
		}

		checkConnections();
	}, [selected]);

	// Render detail view
	const selectedInteg = INTEGRATIONS.find((i) => i.id === selected);
	if (selectedInteg) {
		if (selectedInteg.id === "github") {
			return (
				<div class="content-section">
					<div class="integ-content">
						<GitHubDetail
							onBack={() => {
								lastChecked.current = 0;
								setSelected(null);
							}}
						/>
					</div>
				</div>
			);
		}
		if (selectedInteg.tokenBased) {
			return (
				<div class="content-section">
					<div class="integ-content">
						<TokenIntegrationDetail
							integ={selectedInteg}
							onBack={() => {
								lastChecked.current = 0;
								setSelected(null);
							}}
						/>
					</div>
				</div>
			);
		}
	}

	const connected = INTEGRATIONS.filter((i) => accounts[i.id]?.connected);
	const available = INTEGRATIONS.filter((i) => !accounts[i.id]?.connected);

	return (
		<div class="content-section">
			<div class="integ-content">
				<div class="integ-header">
					<h2 class="integ-title">
						<IconPlug size={20} />
						Integrations
					</h2>
					<p class="integ-subtitle">
						Connect external services to your workspace
					</p>
				</div>

				{loading ? (
					<div class="integ-loading">
						<span class="spinner-sm" />
						<span>Checking connections...</span>
					</div>
				) : (
					<>
						{/* Connected services — prominent with account info */}
						{connected.length > 0 && (
							<div class="integ-section-group">
								<div class="integ-section-label">Connected</div>
								<div class="integ-grid">
									{connected.map((integ) => {
										const acct = accounts[integ.id];
										return (
											<button
												key={integ.id}
												class="integ-tile integ-tile-connected"
												onClick={() => setSelected(integ.id)}
											>
												<div class="integ-tile-icon integ-tile-icon-active">
													{integ.icon()}
												</div>
												<div class="integ-tile-info">
													<span class="integ-tile-name">{integ.name}</span>
													{acct?.username ? (
														<span class="integ-tile-account">
															@{acct.username}
															{acct.email ? ` · ${acct.email}` : ""}
														</span>
													) : acct?.email ? (
														<span class="integ-tile-account">{acct.email}</span>
													) : (
														<span class="integ-tile-account">
															API token configured
														</span>
													)}
												</div>
												<span class="integ-tile-status connected" />
											</button>
										);
									})}
								</div>
							</div>
						)}

						{/* Available services — one-click connect */}
						{available.length > 0 && (
							<div class="integ-section-group">
								{connected.length > 0 && (
									<div class="integ-section-label">Available</div>
								)}
								<div class="integ-grid">
									{available.map((integ) => (
										<button
											key={integ.id}
											class={`integ-tile${!integ.available ? " disabled" : ""}`}
											onClick={() => integ.available && setSelected(integ.id)}
											disabled={!integ.available}
										>
											<div class="integ-tile-icon">{integ.icon()}</div>
											<div class="integ-tile-info">
												<span class="integ-tile-name">{integ.name}</span>
												<span class="integ-tile-desc">{integ.description}</span>
											</div>
											{!integ.available && (
												<span class="badge badge-muted">Soon</span>
											)}
										</button>
									))}
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
