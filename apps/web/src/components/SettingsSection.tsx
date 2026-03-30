import { useState, useEffect, useRef } from "preact/hooks";
import { apiFetch, setAuthToken } from "../api";
import {
	wsConnected,
	showToast,
	logs,
	clearLogs,
	type LogEntry,
} from "../state/store";
import {
	IconShield,
	IconKey,
	IconList,
	IconPlug,
	IconPlus,
	IconX,
	IconChevronDown,
	IconChevronRight,
} from "./Icons";
import { ConfirmModal } from "./ConfirmModal";

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

// ── Port Mapping Card ─────────────────────────────────────────────────────

function PortMappingCard() {
	const [networkInfo, setNetworkInfo] = useState<{
		mode: string;
		mappedPorts: number[];
		codeckPort: number;
	} | null>(null);
	const [newPort, setNewPort] = useState("");
	const [portStatus, setPortStatus] = useState<{
		type: "success" | "error" | "info";
		msg: string;
	} | null>(null);
	const [addingPort, setAddingPort] = useState(false);
	const [removingPort, setRemovingPort] = useState<number | null>(null);
	const [confirmAction, setConfirmAction] = useState<{
		type: "add" | "remove";
		port: number;
	} | null>(null);

	const connected = wsConnected.value;

	async function loadNetworkInfo() {
		try {
			const res = await apiFetch("/api/system/network-info");
			setNetworkInfo(await res.json());
		} catch {
			/* ignore */
		}
	}

	useEffect(() => {
		loadNetworkInfo();
	}, []);

	// Reload after container restart
	useEffect(() => {
		if (connected) {
			if (portStatus?.type === "info") {
				setPortStatus({
					type: "success",
					msg: "Container restarted successfully",
				});
				setTimeout(() => setPortStatus(null), 4000);
			}
			setAddingPort(false);
			setRemovingPort(null);
			loadNetworkInfo();
		}
	}, [connected]);

	function requestAddPort() {
		const port = parseInt(newPort, 10);
		if (!port || port < 1 || port > 65535) {
			setPortStatus({ type: "error", msg: "Port must be 1-65535" });
			return;
		}
		setConfirmAction({ type: "add", port });
	}

	async function executeAddPort(port: number) {
		setAddingPort(true);
		setPortStatus(null);
		try {
			const res = await apiFetch("/api/system/add-port", {
				method: "POST",
				body: JSON.stringify({ port }),
			});
			const data = await res.json();
			if (data.success && data.restarting) {
				setPortStatus({
					type: "info",
					msg: `Port ${port} added. Container restarting...`,
				});
			} else if (data.success && data.alreadyMapped) {
				setPortStatus({
					type: "success",
					msg: `Port ${port} is already mapped`,
				});
			} else if (data.success) {
				setPortStatus({
					type: "success",
					msg: `Port ${port} is accessible (host mode)`,
				});
			} else if (data.requiresRestart) {
				setPortStatus({ type: "error", msg: data.instructions });
			} else {
				setPortStatus({ type: "error", msg: data.error || "Unknown error" });
			}
			setNewPort("");
			loadNetworkInfo();
		} catch {
			setPortStatus({ type: "error", msg: "Failed to add port" });
		} finally {
			setAddingPort(false);
		}
	}

	function requestRemovePort(port: number) {
		setConfirmAction({ type: "remove", port });
	}

	async function executeRemovePort(port: number) {
		setRemovingPort(port);
		setPortStatus(null);
		try {
			const res = await apiFetch("/api/system/remove-port", {
				method: "POST",
				body: JSON.stringify({ port }),
			});
			const data = await res.json();
			if (data.success && data.restarting) {
				setPortStatus({
					type: "info",
					msg: `Port ${port} removed. Container restarting...`,
				});
			} else if (data.success && data.notMapped) {
				setPortStatus({ type: "success", msg: `Port ${port} was not mapped` });
			} else if (data.success) {
				setPortStatus({
					type: "success",
					msg: `Port ${port} removed (host mode)`,
				});
			} else if (data.requiresRestart) {
				setPortStatus({ type: "error", msg: data.instructions });
			} else {
				setPortStatus({ type: "error", msg: data.error || "Unknown error" });
			}
			loadNetworkInfo();
		} catch {
			setPortStatus({ type: "error", msg: "Failed to remove port" });
		} finally {
			setRemovingPort(null);
		}
	}

	function handleConfirmAction() {
		if (!confirmAction) return;
		const { type, port } = confirmAction;
		setConfirmAction(null);
		if (type === "add") executeAddPort(port);
		else executeRemovePort(port);
	}

	if (!networkInfo || networkInfo.mode !== "bridge") return null;

	return (
		<>
			<div class="dash-card">
				<div class="dash-card-title">
					<IconPlug size={14} />
					<span>Port Mapping</span>
				</div>
				{networkInfo.mappedPorts.length > 0 && (
					<div class="dash-ports">
						{networkInfo.mappedPorts.map((p) => (
							<span
								key={p}
								class={`dash-port-tag${removingPort === p ? " removing" : ""}`}
							>
								:{p}
								{p !== networkInfo.codeckPort && (
									<button
										class="dash-port-remove"
										onClick={() => requestRemovePort(p)}
										disabled={removingPort !== null}
										title={`Remove port ${p}`}
									>
										<IconX size={10} />
									</button>
								)}
							</span>
						))}
					</div>
				)}
				<div class="dash-port-add">
					<input
						type="number"
						class="dash-port-input"
						placeholder="Port (e.g. 3000)"
						value={newPort}
						onInput={(e) => setNewPort((e.target as HTMLInputElement).value)}
						onKeyDown={(e) => e.key === "Enter" && requestAddPort()}
						min="1"
						max="65535"
						disabled={addingPort}
					/>
					<button
						class="btn btn-sm btn-primary"
						onClick={requestAddPort}
						disabled={addingPort || !newPort}
					>
						{addingPort ? <span class="spinner-sm" /> : <IconPlus size={14} />}
						Add
					</button>
				</div>
				{portStatus && (
					<div class={`dash-port-status dash-port-status-${portStatus.type}`}>
						{portStatus.type === "info" && <span class="spinner-sm" />}
						{portStatus.msg}
					</div>
				)}
				<div class="dash-meta">
					Mapped ports are accessible at localhost:{"{port}"} from your browser.
					Adding a port restarts the container.
				</div>
			</div>

			<ConfirmModal
				visible={confirmAction !== null}
				title={
					confirmAction?.type === "add"
						? "Map Port to Host"
						: "Remove Port Mapping"
				}
				message={
					confirmAction?.type === "add"
						? `Port ${confirmAction.port} will be mapped to the host. The container will restart (~5s), and active sessions will auto-restore.`
						: `Port ${confirmAction?.port} mapping will be removed. The container will restart (~5s), and active sessions will auto-restore.`
				}
				confirmLabel={
					confirmAction?.type === "add"
						? "Map Port & Restart"
						: "Remove & Restart"
				}
				onConfirm={handleConfirmAction}
				onCancel={() => setConfirmAction(null)}
			/>
		</>
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

// ── Main export ────────────────────────────────────────────────────────────

export function SettingsSection() {
	return (
		<div class="content-section">
			<div class="home-content">
				<div class="home-header">
					<div class="home-title">
						<IconShield size={20} />
						<span>Settings</span>
					</div>
				</div>

				{/* Logs — real-time, last 100 entries */}
				<div style="margin-bottom: 24px">
					<LogsCard />
				</div>

				{/* Security */}
				<div style="margin-bottom: 24px">
					<h3 class="dash-title" style="margin-bottom: 16px">
						<IconShield size={14} /> Security
					</h3>
					<ActiveSessionsCard />
					<div style="margin-top: 16px">
						<AuthLogCard />
					</div>
				</div>

				{/* Ports */}
				<div style="padding-top: 24px; border-top: 1px solid var(--border)">
					<h3 class="dash-title" style="margin-bottom: 16px">
						<IconPlug size={14} /> Ports
					</h3>
					<PortMappingCard />
				</div>
			</div>
		</div>
	);
}
