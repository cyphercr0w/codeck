import type { Section } from "../state/store";

/** Single source of truth for navigation items — used by Sidebar and MobileMenu. */
export const NAV_ITEMS: { section: Section; label: string }[] = [
	{ section: "home", label: "Home" },
	{ section: "chat", label: "Chat" },
	{ section: "claude", label: "Terminal" },
	{ section: "flows", label: "Orchestrator" },
	{ section: "agents", label: "Automated Agents" },
	{ section: "integrations", label: "Integrations" },
	{ section: "config", label: "Agent Config" },
];
