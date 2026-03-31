import { useRef } from "preact/hooks";
import {
	activeSection,
	wsConnected,
	claudeUsage,
	setActiveSection,
	type Section,
} from "../state/store";
import {
	IconHome,
	IconFolder,
	IconTerminal,
	IconBot,
	IconPlug,
	IconSettings,
	IconShield,
	IconBrain,
	IconMonitor,
	IconBridge,
	IconChevronLeft,
	IconChevronRight,
	IconChat,
	IconFlow,
	IconLogout,
} from "./Icons";
import { NAV_ITEMS } from "./nav-items";

function formatReset(iso: string | null): string {
	if (!iso) return "";
	const diff = new Date(iso).getTime() - Date.now();
	if (diff <= 0) return "now";
	const h = Math.floor(diff / 3600000);
	const m = Math.floor((diff % 3600000) / 60000);
	if (h >= 24) return `${Math.floor(h / 24)}d`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function barColor(p: number): string {
	if (p < 60) return "var(--accent)";
	if (p < 85) return "var(--warning)";
	return "var(--error)";
}

function UsageBars({ collapsed }: { collapsed: boolean }) {
	const usage = claudeUsage.value;
	if (!usage?.available) return null;

	if (collapsed) {
		// Show tiny dot indicators when collapsed
		const p5 = usage.fiveHour?.percent ?? 0;
		const p7 = usage.sevenDay?.percent ?? 0;
		return (
			<div class="sidebar-usage collapsed">
				<div
					class="sidebar-usage-dot"
					style={{ background: barColor(p5) }}
					title={`5h: ${p5}%`}
				/>
				<div
					class="sidebar-usage-dot"
					style={{ background: barColor(p7) }}
					title={`7d: ${p7}%`}
				/>
			</div>
		);
	}

	return (
		<div class="sidebar-usage">
			<span class="sidebar-usage-title">Limits</span>
			{usage.fiveHour && (
				<div class="sidebar-usage-row">
					<span class="sidebar-usage-label">5h</span>
					<div class="sidebar-usage-track">
						<div
							class="sidebar-usage-fill"
							style={{
								width: `${Math.min(100, usage.fiveHour.percent)}%`,
								background: barColor(usage.fiveHour.percent),
							}}
						/>
					</div>
					<span class="sidebar-usage-pct">{usage.fiveHour.percent}%</span>
				</div>
			)}
			{usage.sevenDay && (
				<div class="sidebar-usage-row">
					<span class="sidebar-usage-label">7d</span>
					<div class="sidebar-usage-track">
						<div
							class="sidebar-usage-fill"
							style={{
								width: `${Math.min(100, usage.sevenDay.percent)}%`,
								background: barColor(usage.sevenDay.percent),
							}}
						/>
					</div>
					<span class="sidebar-usage-pct">{usage.sevenDay.percent}%</span>
				</div>
			)}
		</div>
	);
}

const SECTION_ICONS: Record<Section, () => preact.JSX.Element> = {
	home: () => <IconHome size={18} />,
	chat: () => <IconChat size={18} />,
	filesystem: () => <IconFolder size={18} />,
	claude: () => <IconTerminal size={18} />,
	subagents: () => <IconFlow size={18} />,
	agents: () => <IconBot size={18} />,
	integrations: () => <IconPlug size={18} />,
	config: () => <IconBrain size={18} />,
	settings: () => <IconSettings size={18} />,
};

interface SidebarProps {
	onSectionChange: (section: Section) => void;
	mobileOpen: boolean;
	onClose: () => void;
	collapsed: boolean;
	onToggleCollapse: () => void;
	autoClose?: boolean;
	onLogout?: () => void;
}

export function Sidebar({
	onSectionChange,
	mobileOpen,
	onClose,
	collapsed,
	onToggleCollapse,
	autoClose,
	onLogout,
}: SidebarProps) {
	const connected = wsConnected.value;
	const current = activeSection.value;
	const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const sidebarClass = `sidebar${mobileOpen ? " open" : ""}${collapsed ? " collapsed" : ""}${autoClose ? " sidebar-auto" : ""}`;

	const handleMouseEnter = autoClose
		? () => {
				if (autoCloseTimer.current) {
					clearTimeout(autoCloseTimer.current);
					autoCloseTimer.current = null;
				}
				if (collapsed) onToggleCollapse();
			}
		: undefined;

	const handleMouseLeave = autoClose
		? () => {
				autoCloseTimer.current = setTimeout(() => {
					if (!collapsed) onToggleCollapse();
				}, 300);
			}
		: undefined;

	return (
		<>
			{mobileOpen && <div class="sidebar-backdrop" onClick={onClose} />}
			<aside
				class={sidebarClass}
				role="navigation"
				aria-label="Main navigation"
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
			>
				<div class={`sidebar-brand${collapsed ? " collapsed" : ""}`}>
					<div class="sidebar-brand-row">
						<span class="sidebar-brand-logo" aria-hidden="true">
							<IconBridge size={22} />
						</span>
						{!collapsed && <span class="sidebar-brand-name">Codeck</span>}
						{!collapsed && (
							<button
								class="sidebar-collapse-btn"
								onClick={onToggleCollapse}
								aria-label="Collapse sidebar"
							>
								<IconChevronLeft size={16} />
							</button>
						)}
					</div>
					{collapsed && (
						<button
							class="sidebar-collapse-btn"
							onClick={onToggleCollapse}
							aria-label="Expand sidebar"
						>
							<IconChevronRight size={16} />
						</button>
					)}
				</div>
				<nav class="sidebar-nav" aria-label="Sections">
					{NAV_ITEMS.map((item) => (
						<button
							key={item.section}
							class={`sidebar-item${current === item.section ? " active" : ""}`}
							onClick={() => {
								setActiveSection(item.section);
								onSectionChange(item.section);
								onClose();
							}}
							aria-label={item.label}
							aria-current={current === item.section ? "page" : undefined}
						>
							<span class="sidebar-icon" aria-hidden="true">
								{SECTION_ICONS[item.section]()}
							</span>
							{!collapsed && item.label}
						</button>
					))}
				</nav>
				<div class="sidebar-footer">
					<div class="sidebar-footer-row">
						<span class={`status-dot${connected ? " online" : ""}`} />
						{!collapsed && (
							<span class="sidebar-status-text">
								{connected ? "Connected" : "Disconnected"}
							</span>
						)}
					</div>
					<button
						class="sidebar-logout-btn"
						onClick={onLogout}
						aria-label="Logout"
						title="Logout"
					>
						<IconLogout size={14} />
						{!collapsed && <span>Logout</span>}
					</button>
				</div>
			</aside>
		</>
	);
}
