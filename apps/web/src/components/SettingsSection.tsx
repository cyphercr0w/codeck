import { useState, useEffect, useRef } from "preact/hooks";
import { apiFetch, setAuthToken } from "../api";
import { showToast, logs, clearLogs, type LogEntry } from "../state/store";
import {
	terminalFontSize,
	terminalFontFamily,
	sidebarPosition,
	sidebarAutoClose,
	accentColor,
	appLanguage,
	setFontSize,
	setFontFamily,
	setSidebarPosition,
	setSidebarAutoClose,
	setAccentColor,
	setAppLanguage,
	ensureFontLoaded,
} from "../state/settings";
import {
	IconShield,
	IconKey,
	IconList,
	IconPlus,
	IconX,
	IconChevronDown,
	IconChevronRight,
} from "./Icons";

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionInfo {
	id: string;
	createdAt: number;
	expiresAt: number;
	ip: string;
	current: boolean;
}

interface AuthLogEntry {
	type: "login_success" | "login_failure";
	ip: string;
	timestamp: number;
}

interface IpGroup {
	ip: string;
	sessions: SessionInfo[];
	hasCurrent: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
	const diff = Math.floor((Date.now() - ts) / 1000);
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

function absoluteTime(ts: number): string {
	return new Date(ts).toLocaleString();
}

function expiresIn(expiresAt: number): { label: string; urgent: boolean } {
	const diff = Math.floor((expiresAt - Date.now()) / 1000);
	if (diff <= 0) return { label: "Expired", urgent: true };
	if (diff < 3600) return { label: `${Math.floor(diff / 60)}m`, urgent: true };
	if (diff < 86400)
		return { label: `${Math.floor(diff / 3600)}h`, urgent: true };
	return { label: `${Math.floor(diff / 86400)}d`, urgent: false };
}

function groupByIp(sessions: SessionInfo[]): IpGroup[] {
	const map = new Map<string, SessionInfo[]>();
	for (const s of sessions) {
		const list = map.get(s.ip) || [];
		list.push(s);
		map.set(s.ip, list);
	}
	return Array.from(map.entries()).map(([ip, list]) => ({
		ip,
		sessions: list.sort((a, b) => b.createdAt - a.createdAt),
		hasCurrent: list.some((s) => s.current),
	}));
}

const PERMISSION_LABELS: Record<string, string> = {
	Read: "Read files",
	Edit: "Edit files",
	Write: "Write files",
	Bash: "Run commands",
	WebFetch: "Fetch URLs",
	WebSearch: "Web search",
};

// ── Theme Color Picker ────────────────────────────────────────────────────

const THEME_PRESETS = [
	{ name: "Indigo", value: "#6366f1" },
	{ name: "Violet", value: "#8b5cf6" },
	{ name: "Blue", value: "#3b82f6" },
	{ name: "Cyan", value: "#06b6d4" },
	{ name: "Emerald", value: "#10b981" },
	{ name: "Amber", value: "#f59e0b" },
	{ name: "Rose", value: "#f43f5e" },
	{ name: "Pink", value: "#ec4899" },
];

function ThemeColorCard() {
	const color = accentColor.value;

	function pickColor(hex: string) {
		setAccentColor(hex);
	}

	return (
		<div class="dash-card">
			<div class="dash-card-title">Theme Color</div>
			<div class="theme-presets">
				{THEME_PRESETS.map((p) => (
					<button
						key={p.value}
						class={`theme-swatch${color === p.value ? " active" : ""}`}
						style={{ background: p.value }}
						onClick={() => pickColor(p.value)}
						title={p.name}
					/>
				))}
				<label class="theme-custom" title="Custom color">
					<input
						type="color"
						value={color}
						onInput={(e) => pickColor((e.target as HTMLInputElement).value)}
					/>
					<span class="theme-custom-label">Custom</span>
				</label>
			</div>
		</div>
	);
}

// ── Terminal Font Card (family + size combined) ──────────────────────────

const FONT_OPTIONS = [
	{ label: "JetBrains Mono", value: "'JetBrains Mono', monospace" },
	{ label: "Fira Code", value: "'Fira Code', monospace" },
	{ label: "Source Code Pro", value: "'Source Code Pro', monospace" },
	{ label: "Cascadia Code", value: "'Cascadia Code', monospace" },
];

function TerminalFontCard() {
	const current = terminalFontFamily.value;
	const size = terminalFontSize.value;
	const [fontsReady, setFontsReady] = useState(false);

	useEffect(() => {
		for (const opt of FONT_OPTIONS) ensureFontLoaded(opt.value);
		document.fonts.ready.then(() => setFontsReady(true));
	}, []);

	void fontsReady;

	return (
		<div class="dash-card">
			<div class="dash-card-title">Terminal Font</div>
			<div class="font-family-options">
				{FONT_OPTIONS.map((opt) => (
					<button
						key={opt.value}
						class={`font-family-option${current === opt.value ? " active" : ""}`}
						onClick={() => setFontFamily(opt.value)}
					>
						<span class="font-family-name">{opt.label}</span>
						<span class="font-family-preview" style={{ fontFamily: opt.value }}>
							{`=> fn(x) { let y = 0; } // @todo`}
						</span>
					</button>
				))}
			</div>
			<div class="font-size-row">
				<span class="font-size-label">Size</span>
				<input
					type="range"
					class="settings-range settings-range-sm"
					min={10}
					max={20}
					value={size}
					onInput={(e) =>
						setFontSize(Number((e.target as HTMLInputElement).value))
					}
				/>
				<span class="settings-range-value">{size}px</span>
				<span class="font-size-sep">|</span>
				<span
					class="font-size-preview"
					style={{ fontSize: `${size}px`, fontFamily: current }}
				>
					Aa
				</span>
			</div>
		</div>
	);
}

// ── Default Model Card ────────────────────────────────────────────────────

// ── Sidebar Card ──────────────────────────────────────────────────────────

const LayoutIcon = ({ side }: { side: "left" | "right" }) => (
	<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
		<rect
			x={side === "left" ? 1 : 11}
			y="1"
			width="4"
			height="14"
			rx="1"
			fill="currentColor"
			opacity="0.9"
		/>
		<rect
			x={side === "left" ? 6 : 1}
			y="1"
			width="9"
			height="14"
			rx="1"
			fill="currentColor"
			opacity="0.3"
		/>
	</svg>
);

function SidebarCard() {
	const pos = sidebarPosition.value;
	const autoClose = sidebarAutoClose.value;

	return (
		<div class="dash-card">
			<div class="dash-card-title">Layout</div>

			{/* Desktop only: sidebar position + auto-close */}
			<div class="settings-desktop-only">
				<div class="settings-label-row" style="margin-bottom: 12px">
					<span class="form-label" style="margin-bottom: 0">
						Sidebar position
					</span>
					<div class="sidebar-pos-btns">
						<button
							class={`sidebar-pos-btn${pos === "left" ? " active" : ""}`}
							onClick={() => setSidebarPosition("left")}
							title="Left"
						>
							<LayoutIcon side="left" />
						</button>
						<button
							class={`sidebar-pos-btn${pos === "right" ? " active" : ""}`}
							onClick={() => setSidebarPosition("right")}
							title="Right"
						>
							<LayoutIcon side="right" />
						</button>
					</div>
				</div>
				<div class="settings-label-row">
					<span class="form-label" style="margin-bottom: 0">
						Auto-close on hover
					</span>
					<label class="settings-toggle">
						<input
							type="checkbox"
							checked={autoClose}
							onChange={(e) =>
								setSidebarAutoClose((e.target as HTMLInputElement).checked)
							}
						/>
						<span class="settings-toggle-slider" />
					</label>
				</div>
			</div>

			{/* Mobile only: menu position (hamburger left or right) */}
			<div class="settings-mobile-only">
				<div class="settings-label-row">
					<span class="form-label" style="margin-bottom: 0">
						Menu position
					</span>
					<div class="sidebar-pos-btns">
						<button
							class={`sidebar-pos-btn${pos === "left" ? " active" : ""}`}
							onClick={() => setSidebarPosition("left")}
							title="Menu left"
						>
							<LayoutIcon side="left" />
						</button>
						<button
							class={`sidebar-pos-btn${pos === "right" ? " active" : ""}`}
							onClick={() => setSidebarPosition("right")}
							title="Menu right"
						>
							<LayoutIcon side="right" />
						</button>
					</div>
				</div>
			</div>

			<div style="border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px">
				<ChangePasswordInline />
			</div>
		</div>
	);
}

// ── Inline Change Password ───────────────────────────────────────────────

function ChangePasswordInline() {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	const [success, setSuccess] = useState(false);
	const [loading, setLoading] = useState(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		setError("");
		setSuccess(false);
		if (next.length < 8) {
			setError("Min 8 characters.");
			return;
		}
		if (next !== confirm) {
			setError("Passwords don't match.");
			return;
		}
		setLoading(true);
		try {
			const res = await apiFetch("/api/auth/change-password", {
				method: "POST",
				body: JSON.stringify({ currentPassword: current, newPassword: next }),
			});
			const data = await res.json();
			if (data.success && data.token) {
				setAuthToken(data.token);
				setSuccess(true);
				setCurrent("");
				setNext("");
				setConfirm("");
			} else {
				setError(data.error || "Failed.");
			}
		} catch {
			setError("Network error.");
		} finally {
			setLoading(false);
		}
	}

	return (
		<form class="settings-password-form" onSubmit={handleSubmit}>
			<span class="dash-card-title" style="margin-bottom: 8px">
				Change Password
			</span>
			<input
				type="password"
				class="settings-input"
				placeholder="Current password"
				value={current}
				onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
				required
				autocomplete="current-password"
			/>
			<input
				type="password"
				class="settings-input"
				placeholder="New password"
				value={next}
				onInput={(e) => setNext((e.target as HTMLInputElement).value)}
				required
				autocomplete="new-password"
			/>
			<input
				type="password"
				class="settings-input"
				placeholder="Repeat new password"
				value={confirm}
				onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
				required
				autocomplete="new-password"
			/>
			{error && <span class="settings-pw-error">{error}</span>}
			{success && <span class="settings-pw-success">Password changed.</span>}
			<button class="btn btn-sm btn-primary" type="submit" disabled={loading}>
				{loading ? "Changing..." : "Change password"}
			</button>
		</form>
	);
}

// ── Language Card ─────────────────────────────────────────────────────────

const LANGUAGE_OPTIONS = [
	{ label: "English", value: "en" },
	{ label: "Español", value: "es" },
	{ label: "Português", value: "pt" },
	{ label: "Français", value: "fr" },
	{ label: "Deutsch", value: "de" },
	{ label: "日本語", value: "ja" },
	{ label: "中文", value: "zh" },
	{ label: "한국어", value: "ko" },
];

function LanguageCard() {
	const lang = appLanguage.value;

	return (
		<div class="dash-card">
			<div class="dash-card-title">Language</div>
			<select
				class="settings-select"
				value={lang}
				onChange={(e) => setAppLanguage((e.target as HTMLSelectElement).value)}
			>
				{LANGUAGE_OPTIONS.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
			<div
				class="dash-meta"
				style="border-top: none; margin-top: 8px; padding-top: 0; font-size: 11px"
			>
				Translation support coming soon — setting saved for future use.
			</div>
		</div>
	);
}

// ── Change Password Card ───────────────────────────────────────────────────

function ChangePasswordCard() {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	const [success, setSuccess] = useState(false);
	const [loading, setLoading] = useState(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		setError("");
		setSuccess(false);

		if (next.length < 8) {
			setError("New password must be at least 8 characters.");
			return;
		}
		if (next !== confirm) {
			setError("Passwords do not match.");
			return;
		}

		setLoading(true);
		try {
			const res = await apiFetch("/api/auth/change-password", {
				method: "POST",
				body: JSON.stringify({ currentPassword: current, newPassword: next }),
			});
			const data = await res.json();
			if (data.success && data.token) {
				setAuthToken(data.token);
				setSuccess(true);
				setCurrent("");
				setNext("");
				setConfirm("");
			} else {
				setError(data.error || "Failed to change password.");
			}
		} catch {
			setError("Network error. Please try again.");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div class="dash-card">
			<div class="dash-card-title">
				<IconKey size={14} />
				<span>Change Password</span>
			</div>
			<form onSubmit={handleSubmit}>
				<div class="form-group">
					<label class="form-label">Current password</label>
					<input
						type="password"
						class="input"
						value={current}
						onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
						required
						autocomplete="current-password"
					/>
				</div>
				<div class="form-group">
					<label class="form-label">New password</label>
					<input
						type="password"
						class="input"
						value={next}
						onInput={(e) => setNext((e.target as HTMLInputElement).value)}
						required
						minLength={8}
						autocomplete="new-password"
					/>
				</div>
				<div class="form-group">
					<label class="form-label">Confirm new password</label>
					<input
						type="password"
						class="input"
						value={confirm}
						onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
						required
						autocomplete="new-password"
					/>
				</div>
				{error && (
					<div class="alert alert-error" style="margin-bottom: 12px">
						{error}
					</div>
				)}
				{success && (
					<div class="form-success">Password updated successfully.</div>
				)}
				<button type="submit" class="btn btn-sm btn-primary" disabled={loading}>
					{loading ? (
						<>
							<span class="spinner-sm" /> Saving...
						</>
					) : (
						"Change Password"
					)}
				</button>
			</form>
		</div>
	);
}

// ── Active Sessions Card (grouped by IP) ─────────────────────────────────

function ActiveSessionsCard() {
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [revoking, setRevoking] = useState<string | null>(null);
	const [revokingIp, setRevokingIp] = useState<string | null>(null);
	const [expandedIps, setExpandedIps] = useState<Set<string>>(new Set());

	function toggleIp(ip: string) {
		setExpandedIps((prev) => {
			const next = new Set(prev);
			if (next.has(ip)) next.delete(ip);
			else next.add(ip);
			return next;
		});
	}

	async function loadSessions() {
		try {
			const res = await apiFetch("/api/auth/sessions");
			const data = await res.json();
			const now = Date.now();
			setSessions(
				(data.sessions || []).filter((s: SessionInfo) => s.expiresAt > now),
			);
		} catch {
			// ignore
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		loadSessions();
	}, []);

	async function revoke(id: string) {
		setRevoking(id);
		try {
			await apiFetch(`/api/auth/sessions/${id}`, { method: "DELETE" });
			setSessions((s) => s.filter((x) => x.id !== id));
		} catch {
			// ignore
		} finally {
			setRevoking(null);
		}
	}

	async function revokeAllForIp(ip: string) {
		setRevokingIp(ip);
		const toRevoke = sessions.filter((s) => s.ip === ip && !s.current);
		try {
			await Promise.all(
				toRevoke.map((s) =>
					apiFetch(`/api/auth/sessions/${s.id}`, { method: "DELETE" }),
				),
			);
			setSessions((prev) => prev.filter((s) => !(s.ip === ip && !s.current)));
		} catch {
			// ignore
		} finally {
			setRevokingIp(null);
		}
	}

	const groups = groupByIp(sessions);

	return (
		<div class="dash-card">
			<div class="dash-card-title">
				<IconShield size={14} />
				<span>Active Sessions</span>
			</div>
			{loading ? (
				<div class="dash-loading">
					<span class="spinner-sm" /> Loading...
				</div>
			) : groups.length === 0 ? (
				<div
					class="dash-meta"
					style="border-top: none; margin-top: 0; padding-top: 0"
				>
					No active sessions.
				</div>
			) : (
				<div class="session-groups">
					{groups.map((group) => {
						const revocable = group.sessions.filter((s) => !s.current);
						const expanded = expandedIps.has(group.ip);
						return (
							<div key={group.ip} class="session-group">
								<div
									class="session-group-header"
									onClick={() => toggleIp(group.ip)}
									style="cursor: pointer"
								>
									<span class="session-group-toggle">
										{expanded ? (
											<IconChevronDown size={12} />
										) : (
											<IconChevronRight size={12} />
										)}
									</span>
									<div class="session-group-ip">
										<code>{group.ip}</code>
										<span class="badge badge-muted">
											{group.sessions.length}
										</span>
										{group.hasCurrent && (
											<span class="badge badge-success">Current</span>
										)}
									</div>
									{revocable.length > 1 && (
										<button
											class="btn btn-xs btn-ghost danger"
											disabled={revokingIp === group.ip}
											onClick={(e) => {
												e.stopPropagation();
												revokeAllForIp(group.ip);
											}}
										>
											{revokingIp === group.ip ? (
												<span class="spinner-sm" />
											) : (
												`Revoke all (${revocable.length})`
											)}
										</button>
									)}
								</div>
								{expanded && (
									<div class="session-group-list">
										{group.sessions.map((s) => {
											const exp = expiresIn(s.expiresAt);
											return (
												<div key={s.id} class="session-group-item">
													<span title={absoluteTime(s.createdAt)}>
														{relativeTime(s.createdAt)}
													</span>
													<span
														class={exp.urgent ? "text-error" : ""}
														title={absoluteTime(s.expiresAt)}
													>
														expires {exp.label}
													</span>
													{s.current ? (
														<span class="session-current-label">
															this session
														</span>
													) : (
														<button
															class="btn btn-xs btn-ghost danger"
															disabled={revoking === s.id}
															onClick={() => revoke(s.id)}
														>
															{revoking === s.id ? (
																<span class="spinner-sm" />
															) : (
																"Revoke"
															)}
														</button>
													)}
												</div>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ── Permissions Card ──────────────────────────────────────────────────────

function PermissionsCard() {
	const [perms, setPerms] = useState<Record<string, boolean> | null>(null);

	useEffect(() => {
		apiFetch("/api/permissions")
			.then((r) => r.json())
			.then((data) => setPerms(data))
			.catch(() => {});
	}, []);

	async function togglePerm(name: string) {
		if (!perms) return;
		const prev = { ...perms };
		setPerms((p) => (p ? { ...p, [name]: !p[name] } : p));
		try {
			await apiFetch("/api/permissions", {
				method: "POST",
				body: JSON.stringify({ [name]: !prev[name] }),
			});
		} catch {
			setPerms(prev);
		}
	}

	async function toggleAll() {
		if (!perms) return;
		const prev = { ...perms };
		const allOn = Object.values(perms).every((v) => v);
		const target = !allOn;
		const updated: Record<string, boolean> = {};
		for (const key of Object.keys(perms)) updated[key] = target;
		setPerms(updated);
		try {
			await apiFetch("/api/permissions", {
				method: "POST",
				body: JSON.stringify(updated),
			});
		} catch {
			setPerms(prev);
		}
	}

	if (!perms) return null;

	const allOn = Object.values(perms).every((v) => v);
	const enabledCount = Object.values(perms).filter((v) => v).length;
	const totalCount = Object.keys(perms).length;

	return (
		<div class="dash-card">
			<div class="dash-card-title">
				<IconShield size={14} />
				<span>Agent Permissions</span>
			</div>
			<label class="dash-perm-toggle dash-perm-select-all">
				<input type="checkbox" checked={allOn} onChange={toggleAll} />
				<span>Select All</span>
			</label>
			<div class="dash-perms">
				{Object.keys(perms).map((p) => (
					<label key={p} class="dash-perm-toggle">
						<input
							type="checkbox"
							checked={perms[p]}
							onChange={() => togglePerm(p)}
						/>
						<span>{PERMISSION_LABELS[p] || p}</span>
					</label>
				))}
			</div>
			<div class="dash-meta">
				{allOn
					? "All permissions granted"
					: `${enabledCount}/${totalCount} enabled`}
			</div>
		</div>
	);
}

// ── Auth Log Card ──────────────────────────────────────────────────────────

function AuthLogCard() {
	const [events, setEvents] = useState<AuthLogEntry[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		apiFetch("/api/auth/log")
			.then((r) => r.json())
			.then((d) => setEvents((d.events || []).slice().reverse()))
			.catch(() => {})
			.finally(() => setLoading(false));
	}, []);

	return (
		<div class="dash-card">
			<div class="dash-card-title">
				<IconList size={14} />
				<span>Authentication Log</span>
			</div>
			{loading ? (
				<div class="dash-loading">
					<span class="spinner-sm" /> Loading...
				</div>
			) : events.length === 0 ? (
				<div
					class="dash-meta"
					style="border-top: none; margin-top: 0; padding-top: 0"
				>
					No authentication events.
				</div>
			) : (
				<div class="dash-table-wrap">
					<table class="dash-table">
						<thead>
							<tr>
								<th>Result</th>
								<th>IP</th>
								<th>Time</th>
							</tr>
						</thead>
						<tbody>
							{events.map((e, i) => (
								<tr key={i}>
									<td>
										{e.type === "login_success" ? (
											<span class="badge badge-success">Success</span>
										) : (
											<span class="badge badge-error">Failed</span>
										)}
									</td>
									<td>
										<code>{e.ip}</code>
									</td>
									<td title={absoluteTime(e.timestamp)}>
										{relativeTime(e.timestamp)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

// ── Environment Variables Card ─────────────────────────────────────────────

function EnvVarsCard() {
	const [vars, setVars] = useState<Array<{ key: string; hasValue: boolean }>>(
		[],
	);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		loadVars();
	}, []);

	async function loadVars() {
		try {
			const res = await apiFetch("/api/codeck/env");
			const data = await res.json();
			setVars(data.vars || []);
		} catch {
			/* ignore */
		}
	}

	async function handleAdd() {
		const key = newKey.trim().toUpperCase();
		if (!key || !newValue) return;
		setSaving(true);
		try {
			const res = await apiFetch("/api/codeck/env", {
				method: "POST",
				body: JSON.stringify({ key, value: newValue }),
			});
			const data = await res.json();
			if (data.success) {
				showToast(`${key} saved`, "success");
				setNewKey("");
				setNewValue("");
				loadVars();
			} else {
				showToast(data.error || "Failed", "error");
			}
		} catch {
			showToast("Connection error", "error");
		}
		setSaving(false);
	}

	async function handleDelete(key: string) {
		try {
			await apiFetch("/api/codeck/env", {
				method: "DELETE",
				body: JSON.stringify({ key }),
			});
			loadVars();
		} catch {
			/* ignore */
		}
	}

	return (
		<div class="dash-card">
			<div class="dash-card-title">
				<IconKey size={14} />
				<span>Environment Variables</span>
			</div>
			<div class="env-hint">
				Variables are injected into every new terminal session. Changes apply on
				next session start.
			</div>
			{vars.length > 0 && (
				<div class="env-list">
					{vars.map((v) => (
						<div key={v.key} class="env-row">
							<code class="env-key">{v.key}</code>
							<span class="env-value">
								{v.hasValue ? "••••••••" : "(empty)"}
							</span>
							<button
								class="btn btn-xs btn-ghost danger"
								onClick={() => handleDelete(v.key)}
							>
								<IconX size={11} />
							</button>
						</div>
					))}
				</div>
			)}
			<div class="env-add">
				<input
					class="input env-input"
					placeholder="KEY_NAME"
					value={newKey}
					onInput={(e) =>
						setNewKey((e.target as HTMLInputElement).value.toUpperCase())
					}
					onKeyDown={(e) => e.key === "Enter" && handleAdd()}
				/>
				<input
					class="input env-input"
					type="text"
					placeholder="value"
					value={newValue}
					onInput={(e) => setNewValue((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => e.key === "Enter" && handleAdd()}
					style="-webkit-text-security: disc"
					autocomplete="off"
					data-1p-ignore
					data-lpignore="true"
				/>
				<button
					class="btn btn-xs btn-primary"
					onClick={handleAdd}
					disabled={saving || !newKey.trim() || !newValue}
				>
					{saving ? <span class="spinner-sm" /> : <IconPlus size={11} />}
				</button>
			</div>
		</div>
	);
}

// ── Logs Card (inline, replaces old LogsDrawer) ──────────────────────────

function LogsCard() {
	const logEntries = logs.value;
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [logEntries.length]);

	return (
		<div class="dash-card">
			<div class="dash-card-title">
				<IconList size={14} />
				<span>Codeck Logs</span>
				<span class="badge badge-muted" style="margin-left: auto">
					{logEntries.length}
				</span>
				{logEntries.length > 0 && (
					<button
						class="btn btn-xs btn-ghost"
						onClick={clearLogs}
						style="margin-left: 8px"
					>
						Clear
					</button>
				)}
			</div>
			<div class="settings-logs" ref={containerRef}>
				{logEntries.length === 0 ? (
					<div
						class="dash-meta"
						style="border-top: none; margin-top: 0; padding-top: 0"
					>
						No logs yet.
					</div>
				) : (
					logEntries.slice(-100).map((entry: LogEntry, i: number) => {
						const time = new Date(entry.timestamp).toLocaleTimeString();
						return (
							<div
								key={i}
								class={`log-entry${entry.type === "error" ? " error" : ""}`}
							>
								<span class={`log-dot ${entry.type}`} />
								<span class="log-time">{time}</span>
								<span>{entry.message}</span>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}

// ── Settings Section (exported) ───────────────────────────────────────────

export function SettingsSection() {
	const [auditOpen, setAuditOpen] = useState(false);

	return (
		<div class="content-section">
			<div class="home-content">
				<div class="home-header">
					<div class="home-title">
						<IconShield size={20} />
						<span>Settings</span>
					</div>
				</div>

				{/* Settings — two-column layout */}
				<div class="settings-appearance">
					<div class="settings-col">
						<ThemeColorCard />
						<SidebarCard />
					</div>
					<div class="settings-divider" />
					<div class="settings-col">
						<TerminalFontCard />
					</div>
				</div>

				{/* Audit & Security — collapsible */}
				<button
					class="settings-audit-toggle"
					onClick={() => setAuditOpen(!auditOpen)}
				>
					<IconShield size={14} />
					<span>Audit & Security</span>
					{auditOpen ? (
						<IconChevronDown size={14} />
					) : (
						<IconChevronRight size={14} />
					)}
				</button>

				{auditOpen && (
					<div class="settings-audit-content">
						<LogsCard />
						<div style="margin-top: 16px">
							<ActiveSessionsCard />
						</div>
						<div style="margin-top: 16px">
							<AuthLogCard />
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
