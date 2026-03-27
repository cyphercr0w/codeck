import { setActiveSection, type Section } from "./state/store";

const SECTION_ROUTES: Record<Section, string> = {
	home: "/",
	chat: "/chat",
	filesystem: "/files",
	claude: "/terminal",
	teams: "/teams",
	agents: "/agents",
	integrations: "/integrations",
	config: "/memory",
	settings: "/settings",
};

const ROUTE_SECTIONS: Record<string, Section> = Object.fromEntries(
	Object.entries(SECTION_ROUTES).map(([section, route]) => [
		route,
		section as Section,
	]),
) as Record<string, Section>;

export function sectionFromUrl(): Section {
	return ROUTE_SECTIONS[location.pathname] || "home";
}

export function pushSection(section: Section): void {
	const path = SECTION_ROUTES[section] || "/";
	if (location.pathname !== path) {
		history.pushState(null, "", path);
	}
}

export function replaceSection(section: Section): void {
	const path = SECTION_ROUTES[section] || "/";
	if (location.pathname !== path) {
		history.replaceState(null, "", path);
	}
}

export function initRouter(): void {
	window.addEventListener("popstate", () => {
		setActiveSection(sectionFromUrl());
	});
}
