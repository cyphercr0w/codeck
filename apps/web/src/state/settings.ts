import { signal } from "@preact/signals";
import { apiFetch } from "../api";

// ── Local cache (localStorage as offline fallback) ────────────────────────

function cacheGet(key: string, fallback: string): string {
	return localStorage.getItem(`codeck-${key}`) || fallback;
}

function cacheGetNum(key: string, fallback: number): number {
	const v = localStorage.getItem(`codeck-${key}`);
	return v ? Number(v) : fallback;
}

function cacheGetBool(key: string, fallback: boolean): boolean {
	const v = localStorage.getItem(`codeck-${key}`);
	return v ? v === "true" : fallback;
}

function cacheSet(key: string, value: string | number | boolean): void {
	localStorage.setItem(`codeck-${key}`, String(value));
}

// ── Persist to server ─────────────────────────────────────────────────────

function persistToServer(key: string, value: string | number | boolean): void {
	cacheSet(key, value);
	apiFetch("/api/system/ui-settings", {
		method: "POST",
		body: JSON.stringify({ [key]: value }),
	}).catch(() => {});
}

// ── Signals (initialized from localStorage cache, hydrated from server) ──

export const terminalFontSize = signal(cacheGetNum("font-size", 14));
export const terminalFontFamily = signal(
	cacheGet("font-family", "'JetBrains Mono', monospace"),
);
export const defaultModel = signal(cacheGet("default-model", "sonnet"));
export const sidebarPosition = signal<"left" | "right">(
	cacheGet("sidebar-position", "left") as "left" | "right",
);
export const sidebarAutoClose = signal(
	cacheGetBool("sidebar-autoclose", false),
);
export const accentColor = signal(cacheGet("accent-color", "#6366f1"));
export const appLanguage = signal(cacheGet("language", "en"));

// ── Hydrate from server (called after app mounts) ─────────────────────────

export async function hydrateFromServer(): Promise<void> {
	try {
		const res = await apiFetch("/api/system/ui-settings");
		const data = await res.json();
		if (!data || typeof data !== "object") return;

		if (data["font-size"] != null) {
			const v = Number(data["font-size"]);
			terminalFontSize.value = v;
			cacheSet("font-size", v);
		}
		if (data["font-family"]) {
			terminalFontFamily.value = data["font-family"];
			cacheSet("font-family", data["font-family"]);
			ensureFontLoaded(data["font-family"]);
		}
		if (data["default-model"]) {
			defaultModel.value = data["default-model"];
			cacheSet("default-model", data["default-model"]);
		}
		if (data["sidebar-position"]) {
			sidebarPosition.value = data["sidebar-position"];
			cacheSet("sidebar-position", data["sidebar-position"]);
		}
		if (data["sidebar-autoclose"] != null) {
			sidebarAutoClose.value =
				data["sidebar-autoclose"] === true ||
				data["sidebar-autoclose"] === "true";
			cacheSet("sidebar-autoclose", sidebarAutoClose.value);
		}
		if (data["accent-color"]) {
			accentColor.value = data["accent-color"];
			cacheSet("accent-color", data["accent-color"]);
			applyAccentColor(data["accent-color"]);
		}
		if (data["language"]) {
			appLanguage.value = data["language"];
			cacheSet("language", data["language"]);
		}

		// Re-apply visual settings after hydration
		applyAccentColor(accentColor.value);
		if (sidebarPosition.value === "right") {
			document.querySelector(".app-layout")?.classList.add("sidebar-right");
		} else {
			document.querySelector(".app-layout")?.classList.remove("sidebar-right");
		}
		applyTerminalFont();
	} catch {
		// Server unreachable — localStorage cache is used as-is
	}
}

// ── Setters (update signal + persist to server) ──────────────────────────

export function setFontSize(v: number): void {
	terminalFontSize.value = v;
	persistToServer("font-size", v);
	applyTerminalFont();
}

const loadedFonts = new Set<string>();
export function ensureFontLoaded(family: string): void {
	if (family.includes("JetBrains")) return;
	const name = family.replace(/'/g, "").split(",")[0].trim();
	if (loadedFonts.has(name)) return;
	loadedFonts.add(name);
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@400;500;600;700&display=swap`;
	document.head.appendChild(link);
}

export function setFontFamily(v: string): void {
	ensureFontLoaded(v);
	terminalFontFamily.value = v;
	persistToServer("font-family", v);
	applyTerminalFont();
}

export function setDefaultModel(v: string): void {
	defaultModel.value = v;
	persistToServer("default-model", v);
}

export function setSidebarPosition(v: "left" | "right"): void {
	sidebarPosition.value = v;
	persistToServer("sidebar-position", v);
}

export function setSidebarAutoClose(v: boolean): void {
	sidebarAutoClose.value = v;
	persistToServer("sidebar-autoclose", v);
}

export function setAccentColor(hex: string): void {
	accentColor.value = hex;
	persistToServer("accent-color", hex);
	applyAccentColor(hex);
}

export function setAppLanguage(v: string): void {
	appLanguage.value = v;
	persistToServer("language", v);
}

// ── Apply accent color to CSS vars ────────────────────────────────────────

export function applyAccentColor(hex: string): void {
	const root = document.documentElement;
	root.style.setProperty("--accent", hex);
	const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (m) {
		const [r, g, b] = [
			parseInt(m[1], 16),
			parseInt(m[2], 16),
			parseInt(m[3], 16),
		];
		const d = (v: number) => Math.max(0, Math.round(v * 0.88));
		root.style.setProperty(
			"--accent-hover",
			`#${[d(r), d(g), d(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
		);
		root.style.setProperty("--accent-subtle", `rgba(${r}, ${g}, ${b}, 0.10)`);
		// Contrast-aware foreground: black on light accents, white on dark
		const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
		root.style.setProperty("--accent-fg", luminance > 150 ? "#000" : "#fff");
	}
}

// ── Apply terminal font to all active xterm instances ─────────────────────

let _applyFn: (() => void) | null = null;

export function registerTerminalApply(fn: () => void): void {
	_applyFn = fn;
}

export function applyTerminalFont(): void {
	_applyFn?.();
}

// ── Boot-time: apply cached settings immediately (no flash) ───────────────

export function applyStoredSettings(): void {
	const hex = accentColor.value;
	if (hex !== "#6366f1") applyAccentColor(hex);
	ensureFontLoaded(terminalFontFamily.value);
	if (sidebarPosition.value === "right") {
		document.querySelector(".app-layout")?.classList.add("sidebar-right");
	}
}
