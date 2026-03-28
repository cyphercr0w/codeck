import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../api";
import { workspacePath, agentName, setActiveSection } from "../state/store";
import { IconFolder, IconPlus, IconGithub, IconChevronLeft } from "./Icons";

type Tab = "existing" | "create" | "clone";
type Step = 1 | 2;

interface NewProjectModalProps {
	visible: boolean;
	/** If set, skip step 1 and open directly on step 2 with this dir */
	initialDir?: string;
	onCancel: () => void;
	onConfirm: (dir: string, options: { command: string }) => void;
}

/**
 * Parse the command input string and return which flags are active.
 */
function parseCommandFlags(command: string): {
	resume: boolean;
	continueFlag: boolean;
	teams: boolean;
} {
	// Tokenize carefully: split on whitespace but respect the flag patterns
	const tokens = command.trim().split(/\s+/);
	return {
		resume: tokens.includes("--resume"),
		continueFlag: tokens.includes("--continue"),
		teams:
			tokens.includes("--teammate-mode") &&
			tokens[tokens.indexOf("--teammate-mode") + 1] === "tmux",
	};
}

/**
 * Build a command string by toggling a flag on/off, preserving any extra user-typed flags.
 */
function toggleFlag(
	command: string,
	flag: string,
	enabled: boolean,
	removeFlags?: string[],
): string {
	let cmd = command;

	// Remove conflicting flags first
	if (removeFlags) {
		for (const rf of removeFlags) {
			if (rf === "--teammate-mode") {
				// Remove --teammate-mode and its argument
				cmd = cmd.replace(/\s*--teammate-mode\s+\S+/, "");
			} else {
				cmd = cmd.replace(
					new RegExp(`\\s*${rf.replace(/-/g, "\\-")}`, "g"),
					"",
				);
			}
		}
	}

	// Remove the flag itself (and argument for --teammate-mode)
	if (flag === "--teammate-mode tmux") {
		cmd = cmd.replace(/\s*--teammate-mode\s+tmux/, "");
	} else {
		cmd = cmd.replace(new RegExp(`\\s*${flag.replace(/-/g, "\\-")}`, "g"), "");
	}

	// Add flag if enabling
	if (enabled) {
		cmd = cmd.trimEnd() + " " + flag;
	}

	// Clean up extra whitespace
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
	const [command, setCommand] = useState("claude");
	const nameRef = useRef<HTMLInputElement>(null);
	const urlRef = useRef<HTMLInputElement>(null);
	const commandRef = useRef<HTMLInputElement>(null);

	// The resolved directory path for step 2
	const [resolvedDir, setResolvedDir] = useState("");

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
			setCommand("claude");
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
					onCancel();
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
	}, [visible, onCancel]);

	useEffect(() => {
		if (tab === "create") nameRef.current?.focus();
		if (tab === "clone") urlRef.current?.focus();
	}, [tab]);

	useEffect(() => {
		if (step === 2) commandRef.current?.focus();
	}, [step]);

	async function loadDirs() {
		setDirs([]);
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
		setCommand("claude");
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
			if (data.success) {
				await advanceToStep2(data.path);
			} else {
				setError(data.error || "Error cloning");
			}
		} catch {
			setError("Connection error");
		} finally {
			setLoading(false);
		}
	}

	function handleStep2Submit() {
		onConfirm(resolvedDir, { command });
	}

	function handleBack() {
		setStep(1);
		setCommand("claude");
		setError("");
	}

	function canAdvance(): boolean {
		if (loading) return false;
		if (tab === "existing") return true;
		if (tab === "create") return newName.trim().length > 0;
		if (tab === "clone") return cloneUrl.trim().length > 0;
		return false;
	}

	// Bidirectional command <-> checkbox sync
	const flags = parseCommandFlags(command);

	function handleResumeToggle(checked: boolean) {
		// --resume and --continue are mutually exclusive
		setCommand(toggleFlag(command, "--resume", checked, ["--continue"]));
	}

	function handleContinueToggle(checked: boolean) {
		// --continue and --resume are mutually exclusive
		setCommand(toggleFlag(command, "--continue", checked, ["--resume"]));
	}

	function handleTeamsToggle(checked: boolean) {
		setCommand(toggleFlag(command, "--teammate-mode tmux", checked));
	}

	function handleCommandInput(value: string) {
		// Ensure "claude" prefix is always present
		if (!value.startsWith("claude")) {
			// Find where the user's extra content starts
			const rest = value.replace(/^[a-z]*\s*/, "");
			setCommand("claude" + (rest ? " " + rest : ""));
		} else {
			setCommand(value);
		}
	}

	const dirShortName = resolvedDir.split("/").pop() || resolvedDir;

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
				{step === 1 && (
					<>
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
								<div class="dir-list">
									<div
										class={`dir-item${selected === ws ? " selected" : ""}`}
										onClick={() => selectDir(ws)}
									>
										<IconFolder size={14} />
										<span>{ws} (default)</span>
									</div>
									{dirs.map((d) => (
										<div
											key={d}
											class={`dir-item${selected === d ? " selected" : ""}`}
											onClick={() => selectDir(d)}
										>
											<IconFolder size={14} />
											<span>{d.split("/").pop()}</span>
										</div>
									))}
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
					</>
				)}

				{step === 2 && (
					<>
						<h2 id="npm-modal-title" class="modal-title">
							Launch terminal in {dirShortName}
						</h2>

						{/* Launch options */}
						<div class="npm-launch-options">
							<div class="npm-launch-title">Launch options</div>

							{canResume && (
								<label class="npm-checkbox">
									<input
										type="checkbox"
										checked={flags.resume}
										onChange={(e) =>
											handleResumeToggle((e.target as HTMLInputElement).checked)
										}
									/>
									<span>Resume previous conversation</span>
									<span class="npm-flag">--resume</span>
								</label>
							)}

							{canResume && (
								<label class="npm-checkbox">
									<input
										type="checkbox"
										checked={flags.continueFlag}
										onChange={(e) =>
											handleContinueToggle(
												(e.target as HTMLInputElement).checked,
											)
										}
									/>
									<span>Continue most recent conversation</span>
									<span class="npm-flag">--continue</span>
								</label>
							)}

							<label class="npm-checkbox">
								<input
									type="checkbox"
									checked={flags.teams}
									onChange={(e) =>
										handleTeamsToggle((e.target as HTMLInputElement).checked)
									}
								/>
								<span>Enable Agent Teams</span>
								<span class="npm-flag">experimental</span>
							</label>
						</div>

						{/* Editable command input */}
						<div style={{ marginBottom: "16px" }}>
							<label
								class="npm-label"
								style={{ marginBottom: "6px", display: "block" }}
							>
								Command
							</label>
							<input
								ref={commandRef}
								type="text"
								class="input"
								style={{ fontFamily: "var(--font-mono)", fontSize: "13px" }}
								value={command}
								onInput={(e) =>
									handleCommandInput((e.target as HTMLInputElement).value)
								}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleStep2Submit();
								}}
							/>
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
							<button class="btn btn-primary" onClick={handleStep2Submit}>
								Open terminal
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
