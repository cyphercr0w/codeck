import { useState, useEffect } from "preact/hooks";
import { apiFetch } from "../api";
import { IconBridge, IconChevronDown } from "./Icons";
import { WizardSteps } from "./WizardSteps";
import "../styles/preset-configurator.css";

const WIZARD_STEPS = [
	{ label: "Password" },
	{ label: "Claude" },
	{ label: "Preset" },
	{ label: "Integrations" },
];

interface PresetItem {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
}

interface PresetContents {
	hooks: PresetItem[];
	skills: PresetItem[];
	agents: PresetItem[];
	mcpServers: PresetItem[];
}

interface PresetConfiguratorProps {
	onComplete: () => void;
}

type CategoryKey = keyof PresetContents;

const CATEGORY_LABELS: Record<CategoryKey, string> = {
	hooks: "Hooks",
	skills: "Skills",
	agents: "Sub-agents",
	mcpServers: "MCP Servers",
};

function Toggle({
	checked,
	onChange,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<label class="pc-toggle" onClick={(e) => e.stopPropagation()}>
			<input
				type="checkbox"
				checked={checked}
				onChange={() => onChange(!checked)}
			/>
			<span class="pc-toggle-track" />
		</label>
	);
}

export function PresetConfigurator({ onComplete }: PresetConfiguratorProps) {
	const [contents, setContents] = useState<PresetContents | null>(null);
	const [loading, setLoading] = useState(true);
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);

	// Per-item enabled state — key: `${category}:${id}`
	const [toggles, setToggles] = useState<Record<string, boolean>>({});

	// Which sections are open in the expanded view
	const [openSections, setOpenSections] = useState<
		Record<CategoryKey, boolean>
	>({
		hooks: false,
		skills: false,
		agents: false,
		mcpServers: false,
	});

	useEffect(() => {
		loadContents();
	}, []);

	async function loadContents() {
		try {
			const res = await apiFetch("/api/presets/contents");
			const data: PresetContents = await res.json();
			setContents(data);

			// Initialise toggles from API-provided enabled state
			const initial: Record<string, boolean> = {};
			for (const cat of Object.keys(data) as CategoryKey[]) {
				for (const item of data[cat]) {
					initial[`${cat}:${item.id}`] = item.enabled;
				}
			}
			setToggles(initial);
		} catch {
			setError("Failed to load preset contents");
		} finally {
			setLoading(false);
		}
	}

	function setItemToggle(cat: CategoryKey, id: string, value: boolean) {
		setToggles((prev) => ({ ...prev, [`${cat}:${id}`]: value }));
	}

	function setAllInCategory(cat: CategoryKey, value: boolean) {
		if (!contents) return;
		const next: Record<string, boolean> = { ...toggles };
		for (const item of contents[cat]) {
			next[`${cat}:${item.id}`] = value;
		}
		setToggles(next);
	}

	function toggleSection(cat: CategoryKey) {
		setOpenSections((prev) => ({ ...prev, [cat]: !prev[cat] }));
	}

	function countEnabled(cat: CategoryKey): { enabled: number; total: number } {
		if (!contents) return { enabled: 0, total: 0 };
		const items = contents[cat];
		const enabled = items.filter(
			(item) => toggles[`${cat}:${item.id}`] ?? item.enabled,
		).length;
		return { enabled, total: items.length };
	}

	function buildSummary(): string {
		if (!contents) return "";
		const parts: string[] = [];
		for (const cat of Object.keys(contents) as CategoryKey[]) {
			const count = contents[cat].length;
			if (count > 0) {
				parts.push(`${count} ${CATEGORY_LABELS[cat].toLowerCase()}`);
			}
		}
		return parts.join(" · ");
	}

	async function handleContinue() {
		setApplying(true);
		setError(null);

		try {
			// Build disabled lists per category
			const disabled: Record<CategoryKey, string[]> = {
				hooks: [],
				skills: [],
				agents: [],
				mcpServers: [],
			};

			if (contents) {
				for (const cat of Object.keys(contents) as CategoryKey[]) {
					for (const item of contents[cat]) {
						if (!toggles[`${cat}:${item.id}`]) {
							disabled[cat].push(item.id);
						}
					}
				}
			}

			const overridesBody = {
				hooks: { disabled: disabled.hooks },
				skills: { disabled: disabled.skills },
				agents: { disabled: disabled.agents },
				mcpServers: { disabled: disabled.mcpServers },
			};

			const [applyRes, overridesRes] = await Promise.all([
				apiFetch("/api/presets/apply", {
					method: "POST",
					body: JSON.stringify({ presetId: "default" }),
				}),
				apiFetch("/api/presets/overrides", {
					method: "POST",
					body: JSON.stringify(overridesBody),
				}),
			]);

			const applyData = await applyRes.json();
			if (!applyData.success) {
				throw new Error(applyData.error || "Error applying preset");
			}

			await overridesRes.json();

			onComplete();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Connection error");
			setApplying(false);
		}
	}

	return (
		<div class="pc-wrapper">
			<WizardSteps steps={WIZARD_STEPS} currentStep={2} />

			<div class="pc-header">
				<div class="pc-header-icon">
					<IconBridge size={48} />
				</div>
				<h1 class="pc-title">Configure Workspace</h1>
				<p class="pc-subtitle">
					Set up your workspace with the recommended preset.
				</p>
			</div>

			<div class="pc-card">
				{loading && (
					<div class="pc-loading">
						<div class="spinner" />
						<span>Loading preset...</span>
					</div>
				)}

				{!loading && contents && (
					<>
						<div class="pc-card-body">
							<div class="pc-card-top">
								<h2 class="pc-card-name">Default Preset</h2>
								<span class="pc-badge">Recommended</span>
							</div>
							<p class="pc-card-desc">
								66 sub-agents, 116 skills, hooks, and MCP servers — fully
								configured for Claude Code development.
							</p>
							<div class="pc-card-counts">{buildSummary()}</div>

							{!expanded && (
								<button
									class="pc-customize-btn"
									onClick={() => setExpanded(true)}
								>
									Customize
								</button>
							)}
						</div>

						{expanded && (
							<div class="pc-sections">
								{(Object.keys(contents) as CategoryKey[]).map((cat) => {
									const { enabled, total } = countEnabled(cat);
									const allOn = enabled === total;
									const isOpen = openSections[cat];

									return (
										<div key={cat} class="pc-section">
											<div
												class="pc-section-header"
												onClick={() => toggleSection(cat)}
											>
												<div class="pc-section-title-group">
													<span class="pc-section-name">
														{CATEGORY_LABELS[cat]}
													</span>
													<span class="pc-section-count">
														{enabled} of {total} enabled
													</span>
												</div>
												<div class="pc-section-actions">
													<Toggle
														checked={allOn}
														onChange={(v) => setAllInCategory(cat, v)}
													/>
													<IconChevronDown
														size={16}
														class={`pc-chevron${isOpen ? " pc-chevron--open" : ""}`}
													/>
												</div>
											</div>

											<div
												class={`pc-section-items${isOpen ? " pc-section-items--open" : ""}`}
											>
												{contents[cat].map((item) => {
													const key = `${cat}:${item.id}`;
													const on = toggles[key] ?? item.enabled;
													return (
														<div key={item.id} class="pc-item">
															<Toggle
																checked={on}
																onChange={(v) => setItemToggle(cat, item.id, v)}
															/>
															<div class="pc-item-text">
																<div class="pc-item-name">{item.name}</div>
																<div class="pc-item-desc">
																	{item.description}
																</div>
															</div>
														</div>
													);
												})}
											</div>
										</div>
									);
								})}
							</div>
						)}

						{error && <div class="pc-error">{error}</div>}

						{applying && (
							<div class="pc-applying">
								<div class="spinner" />
								<span>Configuring your workspace...</span>
							</div>
						)}

						<div class="pc-footer">
							<button
								class="pc-continue-btn"
								disabled={applying}
								onClick={handleContinue}
							>
								{applying ? "Configuring..." : "Continue"}
							</button>
						</div>
					</>
				)}

				{!loading && !contents && error && (
					<div class="pc-error" style="padding: 24px;">
						{error}
					</div>
				)}
			</div>
		</div>
	);
}
