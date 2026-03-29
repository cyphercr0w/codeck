// ── Integration Types ──

export interface SSHStatus {
	hasKey: boolean;
	publicKey: string | null;
	authenticated: boolean;
}

export interface GitHubStatus {
	authenticated: boolean;
	loginInProgress: boolean;
	code: string | null;
	url: string | null;
	username: string | null;
	email: string | null;
	avatarUrl: string | null;
}

export interface IntegrationDef {
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

export interface ConnectedAccount {
	connected: boolean;
	email?: string | null;
	username?: string | null;
}
