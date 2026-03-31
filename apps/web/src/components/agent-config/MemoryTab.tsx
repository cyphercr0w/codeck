import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch, getAuthToken } from "../../api";
import { showToast } from "../../state/store";
import {
	IconBrain,
	IconFolder,
	IconDownload,
	IconPlus,
	IconRefresh,
	IconBookmark,
	IconPlug,
	IconList,
	IconShield,
	IconSettings,
	IconKey,
	IconActivity,
} from "../Icons";
import { ConfirmModal } from "../ConfirmModal";

interface PresetStatus {
	configured: boolean;
	presetId: string | null;
	presetName: string | null;
	version: string | null;
	availableVersion: string | null;
	updateAvailable: boolean;
	autoUpdate: boolean;
}

interface MemoryStats {
	sessionsRemembered: number;
	totalMemoryKB: number;
	dailyLogCount: number;
	decisionsCount: number;
	projectsTracked: number;
	lastActivityAt: number | null;
}

function formatTimeAgo(ts: number | null): string {
	if (!ts) return "Never";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "Just now";
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

interface MemoryTabProps {
	onNavigate?: (
		tab:
			| "memory"
			| "skills"
			| "mcp"
			| "rules"
			| "hooks"
			| "permissions"
			| "env",
	) => void;
}

interface TokenSettings {
	compactionPct: number;
	effortLevel: "low" | "medium" | "high";
	mcpDeferThreshold: number;
	thinkingTokens: number;
}

function TokenOptimizationCard() {
	const [settings, setSettings] = useState<TokenSettings>({
		compactionPct: 50,
		effortLevel: "medium",
		mcpDeferThreshold: 5,
		thinkingTokens: 10000,
	});
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		apiFetch("/api/system/token-settings")
			.then((r) => r.json())
			.then(setSettings)
			.catch(() => {});
	}, []);

	async function saveSettings() {
		setSaving(true);
		setSaved(false);
		try {
			await apiFetch("/api/system/token-settings", {
				method: "POST",
				body: JSON.stringify(settings),
			});
			setDirty(false);
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} catch {
		} finally {
			setSaving(false);
		}
	}

	function update<K extends keyof TokenSettings>(
		key: K,
		value: TokenSettings[K],
	) {
		setSettings((prev) => ({ ...prev, [key]: value }));
		setDirty(true);
		setSaved(false);
	}

	const row: any = {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: "16px",
		padding: "12px 0",
		borderBottom: "1px solid var(--border)",
	};
	const labelCol: any = { flex: "1", minWidth: "0" };
	const ctrlCol: any = {
		flexShrink: "0",
		display: "flex",
		alignItems: "center",
		gap: "8px",
		minWidth: "160px",
		justifyContent: "flex-end",
	};
	const desc: any = {
		fontSize: "11px",
		color: "var(--text-muted)",
		marginTop: "2px",
		lineHeight: "1.4",
	};
	const levels: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];

	return (
		<div class="dash-card">
			<div class="dash-card-title">
				<IconActivity size={14} /> <span>Token Optimization</span>
			</div>

			<div style={row}>
				<div style={labelCol}>
					<div style={{ fontWeight: 500, fontSize: "13px" }}>
						Auto-compact at
					</div>
					<div style={desc}>
						Lower = aggressive compaction. Opus 1M: 30%. Sonnet 200K: 50%.
					</div>
				</div>
				<div style={ctrlCol}>
					<input
						type="range"
						min={10}
						max={90}
						value={settings.compactionPct}
						onInput={(e) =>
							update(
								"compactionPct",
								parseInt((e.target as HTMLInputElement).value, 10),
							)
						}
						style={{ accentColor: "var(--accent)", width: "100px" }}
					/>
					<span
						style={{ fontSize: "12px", minWidth: "32px", textAlign: "right" }}
					>
						{settings.compactionPct}%
					</span>
				</div>
			</div>

			<div style={row}>
				<div style={labelCol}>
					<div style={{ fontWeight: 500, fontSize: "13px" }}>
						Default effort level
					</div>
					<div style={desc}>
						Low = fast & cheap. Medium = balanced. High = thorough.
					</div>
				</div>
				<div style={ctrlCol}>
					<div style={{ display: "flex" }}>
						{levels.map((l, i) => (
							<button
								key={l}
								onClick={() => update("effortLevel", l)}
								style={{
									padding: "4px 10px",
									fontSize: "12px",
									border: "1px solid var(--border)",
									borderLeft: i === 0 ? "1px solid var(--border)" : "none",
									borderRadius:
										i === 0 ? "4px 0 0 4px" : i === 2 ? "0 4px 4px 0" : "0",
									background:
										settings.effortLevel === l
											? "var(--accent)"
											: "transparent",
									color:
										settings.effortLevel === l ? "#fff" : "var(--text-muted)",
									cursor: "pointer",
									transition: "background 0.15s, color 0.15s",
								}}
							>
								{l}
							</button>
						))}
					</div>
				</div>
			</div>

			<div style={row}>
				<div style={labelCol}>
					<div style={{ fontWeight: 500, fontSize: "13px" }}>
						MCP tool defer threshold
					</div>
					<div style={desc}>
						Defer tool definitions when exceeding X% of context.
					</div>
				</div>
				<div style={ctrlCol}>
					<input
						type="range"
						min={1}
						max={20}
						value={settings.mcpDeferThreshold}
						onInput={(e) =>
							update(
								"mcpDeferThreshold",
								parseInt((e.target as HTMLInputElement).value, 10),
							)
						}
						style={{ accentColor: "var(--accent)", width: "100px" }}
					/>
					<span
						style={{ fontSize: "12px", minWidth: "32px", textAlign: "right" }}
					>
						{settings.mcpDeferThreshold}%
					</span>
				</div>
			</div>

			<div style={{ ...row, borderBottom: "none" }}>
				<div style={labelCol}>
					<div style={{ fontWeight: 500, fontSize: "13px" }}>
						Max thinking tokens
					</div>
					<div style={desc}>Cap extended thinking budget. Lower = cheaper.</div>
				</div>
				<div style={ctrlCol}>
					<input
						type="range"
						min={1000}
						max={50000}
						step={1000}
						value={settings.thinkingTokens}
						onInput={(e) =>
							update(
								"thinkingTokens",
								parseInt((e.target as HTMLInputElement).value, 10),
							)
						}
						style={{ accentColor: "var(--accent)", width: "100px" }}
					/>
					<span
						style={{ fontSize: "12px", minWidth: "32px", textAlign: "right" }}
					>
						{settings.thinkingTokens >= 1000
							? `${(settings.thinkingTokens / 1000).toFixed(0)}K`
							: settings.thinkingTokens}
					</span>
				</div>
			</div>

			<div
				style={{
					marginTop: "16px",
					display: "flex",
					alignItems: "center",
					gap: "10px",
				}}
			>
				<button
					class="btn btn-sm btn-primary"
					onClick={saveSettings}
					disabled={!dirty || saving}
				>
					{saving ? "Saving..." : "Save"}
				</button>
				{saved && (
					<span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
						Saved
					</span>
				)}
			</div>
		</div>
	);
}

export function MemoryTab({ onNavigate }: MemoryTabProps) {
	const [memStats, setMemStats] = useState<MemoryStats | null>(null);
	const [presetStatus, setPresetStatus] = useState<PresetStatus | null>(null);

	// Preset actions
	const [showUpdateModal, setShowUpdateModal] = useState(false);
	const [showResetModal, setShowResetModal] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [resetting, setResetting] = useState(false);

	// Migration
	const [exporting, setExporting] = useState(false);
	const [importing, setImporting] = useState(false);
	const [showImportConfirm, setShowImportConfirm] = useState(false);
	const [importFile, setImportFile] = useState<File | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		loadMemoryStats();
		loadPresetStatus();
	}, []);

	async function loadMemoryStats() {
		try {
			const res = await apiFetch("/api/dashboard/memory-stats");
			setMemStats(await res.json());
		} catch {
			/* non-fatal */
		}
	}

	async function loadPresetStatus() {
		try {
			const res = await apiFetch("/api/presets/status");
			setPresetStatus(await res.json());
		} catch {
			/* non-fatal */
		}
	}

	async function handleUpdate() {
		setUpdating(true);
		setShowUpdateModal(false);
		try {
			const res = await apiFetch("/api/presets/update", { method: "POST" });
			const data = await res.json();
			if (data.success) {
				showToast("Preset updated", "success");
				loadPresetStatus();
			} else {
				showToast(data.error || "Update failed", "error");
			}
		} catch {
			showToast("Update failed", "error");
		}
		setUpdating(false);
	}

	async function handleReset() {
		setResetting(true);
		setShowResetModal(false);
		try {
			const res = await apiFetch("/api/presets/reset", { method: "POST" });
			const data = await res.json();
			if (data.success) {
				showToast("Factory defaults restored", "success");
				loadMemoryStats();
				loadPresetStatus();
			} else {
				showToast(data.error || "Reset failed", "error");
			}
		} catch {
			showToast("Reset failed", "error");
		}
		setResetting(false);
	}

	function handleExport() {
		setExporting(true);
		const token = getAuthToken();
		const url = `/api/codeck/export${token ? "?token=" + encodeURIComponent(token) : ""}`;
		const a = document.createElement("a");
		a.href = url;
		a.download = "";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => setExporting(false), 2000);
	}

	function handleImportSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (!file.name.endsWith(".tar.gz") && !file.name.endsWith(".tgz")) {
			showToast("File must be a .tar.gz archive", "error");
			return;
		}
		setImportFile(file);
		setShowImportConfirm(true);
		input.value = "";
	}

	async function handleImportConfirm() {
		if (!importFile) return;
		setShowImportConfirm(false);
		setImporting(true);

		try {
			const base64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () =>
					resolve((reader.result as string).split(",")[1] || "");
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(importFile);
			});

			const res = await apiFetch("/api/codeck/import", {
				method: "POST",
				body: JSON.stringify({ data: base64 }),
			});
			if (res.status === 413) {
				showToast(
					'File too large — if using nginx, add "client_max_body_size 100m;" to your server config and reload nginx.',
					"error",
				);
			} else {
				const data = await res.json();
				if (data.success) {
					showToast(
						`Memory imported — ${data.imported} items restored`,
						"success",
					);
					loadMemoryStats();
				} else {
					showToast(data.error || "Import failed", "error");
				}
			}
		} catch (err) {
			const errMsg = (err as Error).message || "";
			if (
				errMsg.includes("NetworkError") ||
				errMsg.includes("Failed to fetch")
			) {
				showToast(
					"Upload failed — file may be too large for your reverse proxy.",
					"error",
				);
			} else {
				showToast("Import failed: " + errMsg, "error");
			}
		}
		setImporting(false);
		setImportFile(null);
	}

	const hasUpdate = presetStatus?.updateAvailable ?? false;

	return (
		<div class="ac-tab-content">
			{/* Configuration Shortcuts — always visible, top of page */}
			<div class="ac-section">
				<div class="ac-section-title">Configuration</div>
				<div class="mem-shortcuts">
					<button class="mem-shortcut" onClick={() => onNavigate?.("skills")}>
						<IconBookmark size={28} />
						<div>
							<div class="mem-shortcut-title">Skills</div>
							<div class="mem-shortcut-desc">Manage agent capabilities</div>
						</div>
					</button>
					<button class="mem-shortcut" onClick={() => onNavigate?.("mcp")}>
						<IconPlug size={28} />
						<div>
							<div class="mem-shortcut-title">MCP Servers</div>
							<div class="mem-shortcut-desc">External tool integrations</div>
						</div>
					</button>
					<button class="mem-shortcut" onClick={() => onNavigate?.("rules")}>
						<IconList size={28} />
						<div>
							<div class="mem-shortcut-title">Rules</div>
							<div class="mem-shortcut-desc">Coding standards & guidelines</div>
						</div>
					</button>
					<button class="mem-shortcut" onClick={() => onNavigate?.("hooks")}>
						<IconSettings size={28} />
						<div>
							<div class="mem-shortcut-title">Hooks</div>
							<div class="mem-shortcut-desc">Automation scripts</div>
						</div>
					</button>
					<button
						class="mem-shortcut"
						onClick={() => onNavigate?.("permissions")}
					>
						<IconShield size={28} />
						<div>
							<div class="mem-shortcut-title">Permissions</div>
							<div class="mem-shortcut-desc">Tool access controls</div>
						</div>
					</button>
					<button class="mem-shortcut" onClick={() => onNavigate?.("env")}>
						<IconKey size={28} />
						<div>
							<div class="mem-shortcut-title">Environment</div>
							<div class="mem-shortcut-desc">Variables & secrets</div>
						</div>
					</button>
				</div>
			</div>

			{/* Token Optimization — always visible below shortcuts */}
			<div class="ac-section" style={{ marginTop: "20px" }}>
				<TokenOptimizationCard />
			</div>

			{/* ── Footer: memory, preset, migration (secondary) ── */}
			<div class="mem-footer">
				{/* Memory Stats */}
				<div class="ac-section">
					<div class="ac-section-header">
						<div class="ac-section-title">
							<IconBrain size={14} /> Agent Memory
						</div>
						<button
							class="btn btn-xs btn-ghost"
							onClick={loadMemoryStats}
							title="Refresh"
						>
							<IconRefresh size={13} />
						</button>
					</div>
					{memStats ? (
						<div class="mem-stats">
							<div class="mem-stat">
								<span class="mem-stat-value">
									{memStats.sessionsRemembered}
								</span>
								<span class="mem-stat-label">sessions</span>
							</div>
							<div class="mem-stat">
								<span class="mem-stat-value">{memStats.projectsTracked}</span>
								<span class="mem-stat-label">projects</span>
							</div>
							<div class="mem-stat">
								<span class="mem-stat-value">{memStats.decisionsCount}</span>
								<span class="mem-stat-label">decisions</span>
							</div>
							<div class="mem-stat">
								<span class="mem-stat-value">{memStats.dailyLogCount}</span>
								<span class="mem-stat-label">daily logs</span>
							</div>
							<div class="mem-stat">
								<span class="mem-stat-value">
									{memStats.totalMemoryKB >= 1024
										? `${(memStats.totalMemoryKB / 1024).toFixed(1)} MB`
										: `${memStats.totalMemoryKB} KB`}
								</span>
								<span class="mem-stat-label">total size</span>
							</div>
						</div>
					) : (
						<div class="ac-empty">
							<span class="spinner-sm" /> Loading...
						</div>
					)}
					{memStats && (
						<div class="dash-meta" style="margin-top: 8px">
							Last active: {formatTimeAgo(memStats.lastActivityAt)}
						</div>
					)}
				</div>

				{/* Preset + Migration side by side on desktop */}
				<div class="ac-row">
					{presetStatus?.configured && (
						<div class="mem-card">
							<div class="mem-card-header">
								<IconFolder size={16} />
								<div class="mem-card-header-info">
									<span class="mem-card-title">
										{presetStatus.presetName || "Default Preset"}
									</span>
									<span class="mem-card-meta">
										v{presetStatus.version}
										{hasUpdate && (
											<span class="badge badge-info" style="margin-left: 6px">
												v{presetStatus.availableVersion} available
											</span>
										)}
									</span>
								</div>
								<label class="npm-checkbox" style="margin-left: auto">
									<input
										type="checkbox"
										checked={presetStatus?.autoUpdate !== false}
										onChange={async (e) => {
											const enabled = (e.target as HTMLInputElement).checked;
											await apiFetch("/api/preset/auto-update", {
												method: "POST",
												body: JSON.stringify({ enabled }),
											});
											loadPresetStatus();
										}}
									/>
									<span>Auto-update</span>
								</label>
							</div>
							<div class="mem-card-actions">
								{hasUpdate ? (
									<button
										class="btn btn-sm btn-primary"
										onClick={() => setShowUpdateModal(true)}
										disabled={updating}
										style="flex: 1"
									>
										{updating ? <span class="spinner-sm" /> : null}
										Install v{presetStatus.availableVersion}
									</button>
								) : (
									<button
										class="btn btn-sm btn-secondary"
										onClick={() => setShowUpdateModal(true)}
										disabled={updating}
										style="flex: 1"
									>
										{updating ? <span class="spinner-sm" /> : null}
										Re-apply preset
									</button>
								)}
								<button
									class="btn btn-sm btn-secondary"
									onClick={() => setShowResetModal(true)}
									disabled={resetting}
									style="flex: 1"
								>
									{resetting ? <span class="spinner-sm" /> : null}
									Reset
								</button>
							</div>
						</div>
					)}

					{/* Migration */}
					<div class="mem-card">
						<div class="mem-card-header">
							<IconDownload size={16} />
							<div class="mem-card-header-info">
								<span class="mem-card-title">Memory Migration</span>
								<span class="mem-card-meta">
									Export or import all memory, preferences, rules, and skills
								</span>
							</div>
						</div>
						<div class="mem-card-actions">
							<button
								class="btn btn-sm btn-secondary"
								onClick={handleExport}
								disabled={exporting}
								style="flex: 1"
							>
								{exporting ? (
									<span class="spinner-sm" />
								) : (
									<IconDownload size={13} />
								)}
								Export
							</button>
							<button
								class="btn btn-sm btn-secondary"
								onClick={() => importInputRef.current?.click()}
								disabled={importing}
								style="flex: 1"
							>
								{importing ? (
									<span class="spinner-sm" />
								) : (
									<IconPlus size={13} />
								)}
								Import
							</button>
							<input
								ref={importInputRef}
								type="file"
								accept=".tar.gz,.tgz"
								style="display: none"
								onChange={handleImportSelect}
							/>
						</div>
					</div>
				</div>
			</div>
			{/* /mem-footer */}

			<ConfirmModal
				visible={showImportConfirm}
				title="Import Memory"
				message={`This will replace your current memory with "${importFile?.name || "archive"}". Auth config and sessions will NOT be affected.`}
				confirmLabel="Import & Replace"
				onConfirm={handleImportConfirm}
				onCancel={() => {
					setShowImportConfirm(false);
					setImportFile(null);
				}}
			/>
			<ConfirmModal
				visible={showUpdateModal}
				title="Update Preset"
				message="This will update scripts, hooks, skills, and CLAUDE.md to the latest version. Memory and preferences will NOT be touched."
				confirmLabel="Update"
				onConfirm={handleUpdate}
				onCancel={() => setShowUpdateModal(false)}
			/>
			<ConfirmModal
				visible={showResetModal}
				title="Factory Reset"
				message="This will DELETE all memory, daily logs, preferences, and rules, and replace everything with factory defaults. This action cannot be undone."
				confirmLabel="Reset Everything"
				onConfirm={handleReset}
				onCancel={() => setShowResetModal(false)}
			/>
		</div>
	);
}
