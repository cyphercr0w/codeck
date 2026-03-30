import { useState, useEffect, useRef } from "preact/hooks";
import { apiFetch } from "../api";
import { INTEGRATIONS } from "./integrations/registry";
import { WizardSteps } from "./WizardSteps";
import "../styles/integration-wizard.css";

const WIZARD_STEPS = [
	{ label: "Password" },
	{ label: "Claude" },
	{ label: "Preset" },
	{ label: "Integrations" },
];

interface IntegrationWizardProps {
	onComplete: () => void;
}

type GitHubConnectionState = "disconnected" | "connecting" | "connected";

interface GitHubInfo {
	username: string;
	avatarUrl: string | null;
}

export function IntegrationWizard({ onComplete }: IntegrationWizardProps) {
	const [githubState, setGithubState] =
		useState<GitHubConnectionState>("disconnected");
	const [githubInfo, setGithubInfo] = useState<GitHubInfo | null>(null);
	const [githubCode, setGithubCode] = useState<string | null>(null);
	const [githubUrl, setGithubUrl] = useState<string | null>(null);
	const [connectedServices, setConnectedServices] = useState<Set<string>>(
		new Set(),
	);
	const [expandedService, setExpandedService] = useState<string | null>(null);
	const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
	const [savingService, setSavingService] = useState<string | null>(null);
	const [serviceErrors, setServiceErrors] = useState<Record<string, string>>(
		{},
	);

	const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		checkInitialState();
		return () => {
			if (pollIntervalRef.current) {
				clearInterval(pollIntervalRef.current);
			}
		};
	}, []);

	async function checkInitialState() {
		try {
			const [githubRes, envRes] = await Promise.all([
				apiFetch("/api/github/login-status"),
				apiFetch("/api/codeck/env"),
			]);

			const githubData = await githubRes.json();
			if (githubData.authenticated) {
				setGithubState("connected");
				setGithubInfo({
					username: githubData.username ?? "",
					avatarUrl: githubData.avatarUrl ?? null,
				});
			}

			const envData = await envRes.json();
			const configuredKeys: string[] = Array.isArray(envData)
				? envData
				: (envData.keys ?? []);
			const connected = new Set<string>();
			for (const integration of INTEGRATIONS) {
				if (integration.tokenBased && integration.tokenEnvKey) {
					if (configuredKeys.includes(integration.tokenEnvKey)) {
						connected.add(integration.id);
					}
				}
			}
			setConnectedServices(connected);
		} catch {
			// Non-fatal — wizard still usable
		}
	}

	async function connectGitHub() {
		setGithubState("connecting");
		setGithubCode(null);
		setGithubUrl(null);

		try {
			await apiFetch("/api/github/login", { method: "POST" });
		} catch {
			setGithubState("disconnected");
			return;
		}

		pollIntervalRef.current = setInterval(async () => {
			try {
				const res = await apiFetch("/api/github/login-status");
				const data = await res.json();

				if (data.code && !githubCode) {
					setGithubCode(data.code);
				}
				if (data.url && !githubUrl) {
					setGithubUrl(data.url);
				}

				if (data.success || data.authenticated) {
					if (pollIntervalRef.current) {
						clearInterval(pollIntervalRef.current);
						pollIntervalRef.current = null;
					}
					setGithubState("connected");
					setGithubInfo({
						username: data.username ?? "",
						avatarUrl: data.avatarUrl ?? null,
					});
					setGithubCode(null);
					setGithubUrl(null);
				}
			} catch {
				// Keep polling on transient errors
			}
		}, 2000);
	}

	async function saveToken(integrationId: string, envKey: string) {
		const token = tokenInputs[integrationId]?.trim();
		if (!token) return;

		setSavingService(integrationId);
		setServiceErrors((prev) => ({ ...prev, [integrationId]: "" }));

		try {
			const res = await apiFetch("/api/codeck/env", {
				method: "POST",
				body: JSON.stringify({ key: envKey, value: token }),
			});
			const data = await res.json();
			if (data.success || res.ok) {
				setConnectedServices((prev) => new Set([...prev, integrationId]));
				setExpandedService(null);
				setTokenInputs((prev) => ({ ...prev, [integrationId]: "" }));
			} else {
				setServiceErrors((prev) => ({
					...prev,
					[integrationId]: data.error ?? "Failed to save token",
				}));
			}
		} catch {
			setServiceErrors((prev) => ({
				...prev,
				[integrationId]: "Connection error",
			}));
		} finally {
			setSavingService(null);
		}
	}

	function toggleService(integrationId: string) {
		setExpandedService((prev) =>
			prev === integrationId ? null : integrationId,
		);
		setServiceErrors((prev) => ({ ...prev, [integrationId]: "" }));
	}

	const tokenIntegrations = INTEGRATIONS.filter(
		(i) => i.tokenBased && i.id !== "github",
	);

	return (
		<div class="iw-container">
			<WizardSteps steps={WIZARD_STEPS} currentStep={3} />

			<div class="iw-header">
				<h2 class="iw-title">Connect Integrations</h2>
				<p class="iw-subtitle">
					Optional — connect services your agent will use.
				</p>
			</div>

			{/* GitHub Card */}
			<div
				class={`iw-github-card${githubState === "connected" ? " iw-github-card--connected" : ""}`}
			>
				<div class="iw-card-header">
					<div class="iw-card-icon">
						<GitHubIcon />
					</div>
					<div class="iw-card-info">
						<div class="iw-card-name">GitHub</div>
						<div class="iw-card-desc">
							Repository access, PRs, issues, and code search
						</div>
					</div>
					{githubState === "disconnected" && (
						<button class="iw-btn iw-btn--primary" onClick={connectGitHub}>
							Connect
						</button>
					)}
					{githubState === "connecting" && (
						<span class="iw-connecting-label">Connecting...</span>
					)}
					{githubState === "connected" && (
						<div class="iw-connected-badge">
							<CheckIcon />
							<span>{githubInfo?.username ?? "Connected"}</span>
						</div>
					)}
				</div>

				{githubState === "connecting" && githubCode && (
					<div class="iw-device-flow">
						<p class="iw-device-label">Enter this code on GitHub:</p>
						<div class="iw-device-code">{githubCode}</div>
						{githubUrl && (
							<a
								class="iw-device-link"
								href={githubUrl}
								target="_blank"
								rel="noopener noreferrer"
							>
								Open GitHub to authorize
							</a>
						)}
						<p class="iw-device-hint">Waiting for authorization...</p>
					</div>
				)}

				{githubState === "connecting" && !githubCode && (
					<div class="iw-device-flow">
						<p class="iw-device-hint">Starting device auth flow...</p>
					</div>
				)}
			</div>

			{/* Token-based integrations grid */}
			<div class="iw-grid">
				{tokenIntegrations.map((integration) => {
					const isConnected = connectedServices.has(integration.id);
					const isExpanded = expandedService === integration.id;
					const isSaving = savingService === integration.id;
					const error = serviceErrors[integration.id];
					const token = tokenInputs[integration.id] ?? "";

					return (
						<div
							key={integration.id}
							class={`iw-service-card${isConnected ? " iw-service-card--connected" : ""}`}
						>
							<div class="iw-card-header">
								<div class="iw-card-icon iw-card-icon--sm">
									{integration.icon()}
								</div>
								<div class="iw-card-info">
									<div class="iw-card-name">{integration.name}</div>
									<div class="iw-card-desc">{integration.description}</div>
								</div>
								{isConnected ? (
									<div class="iw-connected-badge iw-connected-badge--sm">
										<CheckIcon />
										<span>Connected</span>
									</div>
								) : (
									<button
										class={`iw-btn iw-btn--secondary${isExpanded ? " iw-btn--active" : ""}`}
										onClick={() => toggleService(integration.id)}
									>
										{isExpanded ? "Cancel" : "Connect"}
									</button>
								)}
							</div>

							{isExpanded && !isConnected && (
								<div class="iw-token-form">
									{integration.tokenHint && (
										<p class="iw-token-hint">{integration.tokenHint}</p>
									)}
									<div class="iw-token-row">
										<input
											class="iw-token-input"
											type="password"
											placeholder={`Paste ${integration.tokenEnvKey ?? "token"}`}
											value={token}
											onInput={(e) => {
												const val = (e.target as HTMLInputElement).value;
												setTokenInputs((prev) => ({
													...prev,
													[integration.id]: val,
												}));
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter" && integration.tokenEnvKey) {
													saveToken(integration.id, integration.tokenEnvKey);
												}
											}}
										/>
										<button
											class="iw-btn iw-btn--primary"
											disabled={!token || isSaving}
											onClick={() => {
												if (integration.tokenEnvKey) {
													saveToken(integration.id, integration.tokenEnvKey);
												}
											}}
										>
											{isSaving ? "Saving..." : "Save"}
										</button>
									</div>
									{error && <p class="iw-token-error">{error}</p>}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* Footer actions */}
			<div class="iw-footer">
				<button class="iw-btn iw-btn--ghost" onClick={onComplete}>
					Skip for now
				</button>
				<button class="iw-btn iw-btn--primary" onClick={onComplete}>
					Continue
				</button>
			</div>
		</div>
	);
}

function GitHubIcon() {
	return (
		<svg
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}
