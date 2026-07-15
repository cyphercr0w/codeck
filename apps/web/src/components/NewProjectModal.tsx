import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../api";
import {
	workspacePath,
	agentName,
	setActiveSection,
	cloneProgress,
	clearCloneProgress,
} from "../state/store";
import { IconFolder, IconPlus, IconGithub, IconChevronLeft } from "./Icons";

type Tab = "existing" | "create" | "clone";
type Step = 1 | 2;

interface NewProjectModalProps {
	visible: boolean;
	/** If set, skip step 1 and open directly on step 2 with this dir */
	initialDir?: string;
	onCancel: () => void;
	onConfirm: (
		dir: string,
		options: { command: string; enableTeams: boolean; maxTeammates: number },
	) => void;
}

/** Known safe flags that users can type in the params input */
const ALLOWED_FLAGS = new Set(["--resume", "--verbose", "--debug"]);

/** Flags blocked by the backend — shown as error if user types them */
const BLOCKED_FLAGS = new Set([
	"--dangerously-skip-permissions",
	"--allowedTools",
	"-p",
	"--prompt",
	"--model",
	"--permission-mode",
	"--output-format",
	"--mcp-config",
	"--append-system-prompt",
	"--prefill",
]);

/** Parse params string (without "claude" prefix) and return which flags are active. */
function parseCommandFlags(params: string): {
	resume: boolean;
} {
	const tokens = params.trim().split(/\s+/).filter(Boolean);
	return {
		resume: tokens.includes("--resume"),
	};
}

/** Validate params and return error message if invalid, or empty string if OK. */
function validateParams(params: string): string {
	const tokens = params.trim().split(/\s+/).filter(Boolean);
	for (const token of tokens) {
		if (!token.startsWith("-")) continue; // skip flag values like "tmux"
		if (BLOCKED_FLAGS.has(token)) return `Flag "${token}" is not allowed`;
		if (!ALLOWED_FLAGS.has(token)) return `Unknown flag "${token}"`;
	}
	return "";
}

const PREFS_KEY_PREFIX = "codeck_launch_prefs_";

function loadLaunchPrefs(dir: string): {
	resume: boolean;
	teams: boolean;
	maxTeammates: number;
} {
	try {
		const raw = localStorage.getItem(PREFS_KEY_PREFIX + dir);
		if (raw) return JSON.parse(raw);
	} catch {}
	return { resume: false, teams: false, maxTeammates: 3 };
}

function saveLaunchPrefs(
	dir: string,
	prefs: {
		resume: boolean;
		teams: boolean;
		maxTeammates: number;
	},
): void {
	try {
		localStorage.setItem(PREFS_KEY_PREFIX + dir, JSON.stringify(prefs));
	} catch {}
}

/** Toggle a flag on/off in the params string, preserving other user-typed flags. */
function toggleFlag(
	params: string,
	flag: string,
	enabled: boolean,
	removeFlags?: string[],
): string {
	let cmd = params;

	if (removeFlags) {
		for (const rf of removeFlags) {
			cmd = cmd.replace(new RegExp(`\\s*${rf.replace(/-/g, "\\-")}`, "g"), "");
		}
	}

	cmd = cmd.replace(new RegExp(`\\s*${flag.replace(/-/g, "\\-")}`, "g"), "");

	if (enabled) {
		cmd = cmd.trimEnd() + " " + flag;
	}

	return cmd.replace(/\s+/g, " ").trim();
}

export function NewProjectModal({
	visible,
	initialDir,
	onCancel,
	onConfirm,
}: NewProjectModalProps) {
	const modalRef = useRef<HTMLDivElement>(null);
	const [step, setStep] = useState<Step>(1);
	const [tab, setTab] = useState<Tab>("existing");
	const [dirs, setDirs] = useState<string[]>([]);
	const [dirsLoading, setDirsLoading] = useState(false);
	const ws = workspacePath.value;
	const [selected, setSelected] = useState(ws);
	const [newName, setNewName] = useState("");
	const [cloneUrl, setCloneUrl] = useState("");
	const [cloneName, setCloneName] = useState("");
	const [cloneBranch, setCloneBranch] = useState("");
	const [canResume, setCanResume] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [sshConfigured, setSshConfigured] = useState(false);
	const [params, setParams] = useState("");
	const [paramError, setParamError] = useState("");
	const nameRef = useRef<HTMLInputElement>(null);
	const urlRef = useRef<HTMLInputElement>(null);
	const commandRef = useRef<HTMLInputElement>(null);
	const [commandEditable, setCommandEditable] = useState(false);
	const [teamsEnabled, setTeamsEnabled] = useState(false);
	const [maxTeammates, setMaxTeammates] = useState(3);
	const [dirFilter, setDirFilter] = useState("");

	// The resolved directory path for step 2
	const [resolvedDir, setResolvedDir] = useState("");

	// Stable ref for onCancel — avoids re-running the init effect when the parent
	// passes a new inline function on each render (which would reset step to 1).
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	useEffect(() => {
		if (visible) {
			setTab("existing");
			setSelected(ws);
			setNewName("");
			setCloneUrl("");
			setCloneName("");
			setCloneBranch("");
			setCanResume(false);
			setLoading(false);
			setError("");
			setParams("");
			setParamError("");
			setCommandEditable(false);
			setDirFilter("");
			loadDirs();
			checkSshStatus();

			// If initialDir provided, skip to step 2 directly
			if (initialDir) {
				setResolvedDir(initialDir);
				setStep(2);
				checkConversations(initialDir);
			} else {
				setResolvedDir("");
				setStep(1);
			}

			// Focus trap and Escape handler
			const handleKeyDown = (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					onCancelRef.current();
					return;
				}
				if (e.key === "Tab") {
					const focusableEls = modalRef.current?.querySelectorAll<HTMLElement>(
						'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
					);
					if (!focusableEls || focusableEls.length === 0) return;
					const firstEl = focusableEls[0];
					const lastEl = focusableEls[focusableEls.length - 1];
					if (e.shiftKey && document.activeElement === firstEl) {
						e.preventDefault();
						lastEl.focus();
					} else if (!e.shiftKey && document.activeElement === lastEl) {
						e.preventDefault();
						firstEl.focus();
					}
				}
			};
			document.addEventListener("keydown", handleKeyDown);
			return () => document.removeEventListener("keydown", handleKeyDown);
		}
	}, [visible]);

	useEffect(() => {
		if (tab === "create") nameRef.current?.focus();
		if (tab === "clone") urlRef.current?.focus();
		setDirFilter("");
	}, [tab]);

	async function loadDirs() {
		setDirs([]);
		setDirsLoading(true);
		try {
			const res = await apiFetch("/api/files?path=&type=dir");
			const data = await res.json();
			if (data.success) {
				const subdirs = data.items
					.filter((i: { isDirectory: boolean }) => i.isDirectory)
					.map((i: { name: string }) => ws + "/" + i.name);
				setDirs(subdirs);
			}
		} catch {
			/* ignore */
		} finally {
			setDirsLoading(false);
		}
	}

	async function checkConversations(cwd: string) {
		try {
			const res = await apiFetch(
				`/api/console/has-conversations?cwd=${encodeURIComponent(cwd)}`,
			);
			const data = await res.json();
			setCanResume(!!data.hasConversations);
		} catch {
			setCanResume(false);
		}
	}

	function selectDir(dir: string) {
		setSelected(dir);
		checkConversations(dir);
	}

	async function checkSshStatus() {
		try {
			const res = await apiFetch("/api/ssh/status");
			const data = await res.json();
			setSshConfigured(data.hasKey);
		} catch {
			/* ignore */
		}
	}

	function isSSHUrl(url: string): boolean {
		return url.startsWith("git@") || url.includes("ssh://");
	}

	/** Advance from step 1 to step 2 for the "existing" and "create" tabs */
	async function advanceToStep2(dir: string) {
		setResolvedDir(dir);
		const prefs = loadLaunchPrefs(dir);
		let initialParams = "";
		if (prefs.resume) initialParams += " --resume";
		setTeamsEnabled(prefs.teams ?? false);
		setMaxTeammates(prefs.maxTeammates ?? 3);
		setParams(initialParams.trim());
		setParamError("");
		setCanResume(false);
		await checkConversations(dir);
		setStep(2);
	}

	/** Handle the "Next" button for step 1 */
	async function handleStep1Next() {
		if (tab === "existing") {
			await advanceToStep2(selected);
		} else if (tab === "create") {
			await handleCreateFolder();
		} else if (tab === "clone") {
			await handleClone();
		}
	}

	async function handleCreateFolder() {
		const name = newName.trim();
		if (!name) return;

		setError("");
		setLoading(true);
		try {
			const res = await apiFetch("/api/projects/create", {
				method: "POST",
				body: JSON.stringify({ name }),
			});
			const data = await res.json();
			if (data.success) {
				await advanceToStep2(data.path);
			} else {
				setError(data.error || "Error creating folder");
			}
		} catch {
			setError("Connection error");
		} finally {
			setLoading(false);
		}
	}

	async function handleClone() {
		const url = cloneUrl.trim();
		if (!url) return;

		setError("");
		clearCloneProgress();
		setLoading(true);
		try {
			const body: Record<string, string> = { url };
			if (cloneName.trim()) body.name = cloneName.trim();
			if (cloneBranch.trim()) body.branch = cloneBranch.trim();

			const res = await apiFetch("/api/projects/clone", {
				method: "POST",
				body: JSON.stringify(body),
			});
			const data = await res.json();
			clearCloneProgress();
			if (data.success) {
				await advanceToStep2(data.path);
			} else {
				setError(data.error || "Error cloning");
			}
		} catch {
			setError("Connection error");
		} finally {
			clearCloneProgress();
			setLoading(false);
		}
	}

	function handleStep2Submit() {
		const currentFlags = parseCommandFlags(params);
		saveLaunchPrefs(resolvedDir, {
			resume: currentFlags.resume,
			teams: teamsEnabled,
			maxTeammates,
		});
		const fullCommand = params.trim() ? `claude ${params.trim()}` : "claude";
		onConfirm(resolvedDir, {
			command: fullCommand,
			enableTeams: teamsEnabled,
			maxTeammates,
		});
	}

	function handleBack() {
		setStep(1);
		setParams("");
		setParamError("");
		setError("");
	}

	function canAdvance(): boolean {
		if (loading) return false;
		if (tab === "existing") return true;
		if (tab === "create") return newName.trim().length > 0;
		if (tab === "clone") return cloneUrl.trim().length > 0;
		return false;
	}

	// Bidirectional params <-> checkbox sync
	const flags = parseCommandFlags(params);

	function handleResumeToggle(checked: boolean) {
		setParams(toggleFlag(params, "--resume", checked));
	}

	function handleParamsInput(value: string) {
		setParams(value);
		setParamError(validateParams(value));
	}

	const dirShortName = resolvedDir.split("/").pop() || resolvedDir;
	const filteredDirs = dirFilter
		? dirs.filter((d) =>
				(d.split("/").pop() || "")
					.toLowerCase()
					.includes(dirFilter.toLowerCase()),
			)
		: dirs;

	if (!visible) return null;

	return (
		<div class="modal-overlay" onClick={onCancel}>
			<div
				ref={modalRef}
				class="modal"
				style={{ maxWidth: "480px" }}
				role="dialog"
				aria-modal="true"
				aria-labelledby="npm-modal-title"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Step indicator */}
				<div class="modal-steps" aria-label="Progress">
					<div
						class={`modal-step${step === 1 ? " active" : ""}`}
						aria-current={step === 1 ? "step" : undefined}
					>
						<span class="modal-step-num">1</span>
						<span>Choose folder</span>
					</div>
					<div class="modal-step-connector" aria-hidden="true" />
					<div
						class={`modal-step${step === 2 ? " active" : ""}`}
						aria-current={step === 2 ? "step" : undefined}
					>
						<span class="modal-step-num">2</span>
						<span>Launch options</span>
					</div>
				</div>

				{step === 1 && (
					<div class="npm-step-content">
						<h2 id="npm-modal-title" class="modal-title">
							New {agentName.value} session
						</h2>

						{/* Tabs */}
						<div class="npm-tabs" role="tablist" aria-label="Session type">
							<button
								class={`npm-tab${tab === "existing" ? " active" : ""}`}
								role="tab"
								aria-selected={tab === "existing"}
								onClick={() => {
									setTab("existing");
									setError("");
								}}
							>
								<IconFolder size={14} />
								Existing folder
							</button>
							<button
								class={`npm-tab${tab === "create" ? " active" : ""}`}
								role="tab"
								aria-selected={tab === "create"}
								onClick={() => {
									setTab("create");
									setError("");
								}}
							>
								<IconPlus size={14} />
								New folder
							</button>
							<button
								class={`npm-tab${tab === "clone" ? " active" : ""}`}
								role="tab"
								aria-selected={tab === "clone"}
								onClick={() => {
									setTab("clone");
									setError("");
								}}
							>
								<IconGithub size={14} />
								Clone repo
							</button>
						</div>

						{/* Tab content */}
						<div class="npm-content">
							{tab === "existing" && (
								<div class="dir-list" role="listbox" aria-label="Select folder">
									{dirsLoading ? (
										<div class="npm-dirs-loading">
											<span class="loading" />
										</div>
									) : (
										<>
											<div
												class={`dir-item${selected === ws ? " selected" : ""}`}
												role="option"
												aria-selected={selected === ws}
												tabIndex={0}
												onClick={() => selectDir(ws)}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														selectDir(ws);
													}
												}}
											>
												<IconFolder size={14} />
												<span>{ws} (default)</span>
											</div>
											{dirs.length > 3 && (
												<div class="dir-search">
													<input
														type="text"
														class="dir-search-input"
														placeholder="Search folders..."
														value={dirFilter}
														onInput={(e) =>
															setDirFilter((e.target as HTMLInputElement).value)
														}
													/>
												</div>
											)}
											{filteredDirs.map((d) => (
												<div
													key={d}
													class={`dir-item${selected === d ? " selected" : ""}`}
													role="option"
													aria-selected={selected === d}
													tabIndex={0}
													onClick={() => selectDir(d)}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															selectDir(d);
														}
													}}
												>
													<IconFolder size={14} />
													<span>{d.split("/").pop()}</span>
												</div>
											))}
											{filteredDirs.length === 0 && (
												<div class="npm-dirs-empty">
													{dirFilter
														? "No matching folders"
														: "No subfolders found"}
												</div>
											)}
										</>
									)}
								</div>
							)}

							{tab === "create" && (
								<div class="npm-form">
									<label class="npm-label">Folder name</label>
									<input
										ref={nameRef}
										type="text"
										class="input"
										placeholder="my-project"
										value={newName}
										onInput={(e) =>
											setNewName((e.target as HTMLInputElement).value)
										}
										onKeyDown={(e) => {
											if (e.key === "Enter" && canAdvance()) handleStep1Next();
										}}
									/>
									<p class="npm-hint">
										Will be created in {ws}/{newName.trim() || "..."}
									</p>
								</div>
							)}

							{tab === "clone" && (
								<div class="npm-form">
									<label class="npm-label">Repository URL</label>
									<input
										ref={urlRef}
										type="text"
										class="input"
										placeholder="https://github.com/user/repo.git"
										value={cloneUrl}
										onInput={(e) =>
											setCloneUrl((e.target as HTMLInputElement).value)
										}
										onKeyDown={(e) => {
											if (e.key === "Enter" && canAdvance()) handleStep1Next();
										}}
									/>

									{/* SSH warning */}
									{cloneUrl && isSSHUrl(cloneUrl) && !sshConfigured && (
										<div class="npm-warning">
											SSH keys not configured. Private repos will fail.
										</div>
									)}

									<div class="npm-hint">
										For private repos,{" "}
										<button
											class="npm-link"
											type="button"
											onClick={() => {
												onCancel();
												setActiveSection("integrations");
												history.pushState(null, "", "/integrations");
											}}
										>
											configure SSH keys or connect your GitHub account
										</button>{" "}
										in Integrations first.
									</div>

									<div class="npm-row">
										<div style={{ flex: 1 }}>
											<label class="npm-label">Name (optional)</label>
											<input
												type="text"
												class="input"
												placeholder="auto-detected"
												value={cloneName}
												onInput={(e) =>
													setCloneName((e.target as HTMLInputElement).value)
												}
											/>
										</div>
										<div style={{ flex: 1 }}>
											<label class="npm-label">Branch (optional)</label>
											<input
												type="text"
												class="input"
												placeholder="default"
												value={cloneBranch}
												onInput={(e) =>
													setCloneBranch((e.target as HTMLInputElement).value)
												}
											/>
										</div>
									</div>
								</div>
							)}
						</div>

						{error && (
							<div class="npm-error" role="alert">
								{error}
							</div>
						)}

						{/* Clone progress log — visible during active clone */}
						{loading && tab === "clone" && cloneProgress.value.length > 0 && (
							<div class="npm-clone-log" aria-live="polite">
								{cloneProgress.value.slice(-6).map((line, i) => (
									<div key={i} class="npm-clone-line">
										{line}
									</div>
								))}
							</div>
						)}

						<div class="modal-actions">
							<button
								class="btn btn-secondary"
								onClick={onCancel}
								disabled={loading}
							>
								Cancel
							</button>
							<button
								class="btn btn-primary"
								onClick={handleStep1Next}
								disabled={!canAdvance()}
							>
								{loading ? <span class="loading" /> : null}
								{tab === "clone" ? "Clone and continue" : "Next"}
							</button>
						</div>
					</div>
				)}

				{step === 2 && (
					<div class="npm-step-content">
						<h2 id="npm-modal-title" class="modal-title">
							Launch terminal in {dirShortName}
						</h2>

						{/* Launch options */}
						<div class="npm-launch-options">
							<div class="npm-launch-title">Launch options</div>

							{canResume && (
								<>
									<div class="npm-launch-subtitle">Session</div>
									<div role="group" aria-label="Conversation resume mode">
										<label class="npm-checkbox">
											<input
												type="checkbox"
												checked={flags.resume}
												onChange={(e) =>
													handleResumeToggle(
														(e.target as HTMLInputElement).checked,
													)
												}
											/>
											<span>Resume previous conversation</span>
											<span class="npm-flag">--resume</span>
										</label>
									</div>
								</>
							)}

						</div>

						{/* Command input with locked "claude" prefix */}
						<div style={{ marginBottom: "16px" }}>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									marginBottom: "6px",
								}}
							>
								<label class="npm-label" style={{ margin: 0 }}>
									Command
								</label>
								<button
									type="button"
									class="btn-icon"
									title={
										commandEditable ? "Lock command" : "Edit command (advanced)"
									}
									onClick={() => {
										const next = !commandEditable;
										setCommandEditable(next);
										if (next) setTimeout(() => commandRef.current?.focus(), 50);
									}}
									style={{
										padding: "2px 6px",
										fontSize: "12px",
										opacity: 0.7,
										background: "none",
										border: "1px solid var(--border-color, #444)",
										borderRadius: "4px",
										cursor: "pointer",
										color: "var(--text-secondary, #999)",
									}}
								>
									{commandEditable ? "lock" : "edit"}
								</button>
							</div>
							<div
								class="npm-command-wrap"
								style={{ opacity: commandEditable ? 1 : 0.6 }}
							>
								<span
									class="npm-command-prefix"
									title="The 'claude' command is fixed — add flags in the input"
								>
									claude
								</span>
								<input
									ref={commandRef}
									type="text"
									class="input"
									placeholder={commandEditable ? "additional flags..." : ""}
									value={params}
									disabled={!commandEditable}
									onInput={(e) =>
										handleParamsInput((e.target as HTMLInputElement).value)
									}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !paramError) handleStep2Submit();
									}}
									style={{ cursor: commandEditable ? "text" : "default" }}
								/>
							</div>
							{paramError && (
								<div
									class="npm-error"
									style={{ marginTop: "6px" }}
									role="alert"
								>
									{paramError}
								</div>
							)}
						</div>

						{error && (
							<div class="npm-error" role="alert">
								{error}
							</div>
						)}

						<div class="modal-actions">
							<button
								class="btn btn-secondary"
								onClick={handleBack}
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: "4px",
								}}
							>
								<IconChevronLeft size={14} />
								Back
							</button>
							<button
								class="btn btn-primary"
								onClick={handleStep2Submit}
								disabled={!!paramError}
							>
								Open terminal
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
