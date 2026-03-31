import { signal } from "@preact/signals";

// ── Storage helpers ───────────────────────────────────────────────────────

function load(key: string, fallback: string): string {
	return localStorage.getItem(`codeck-${key}`) || fallback;
}

function loadNum(key: string, fallback: number): number {
	const v = localStorage.getItem(`codeck-${key}`);
	return v ? Number(v) : fallback;
}

function loadBool(key: string, fallback: boolean): boolean {
	const v = localStorage.getItem(`codeck-${key}`);
	return v ? v === "true" : fallback;
}

function save(key: string, value: string | number | boolean): void {
	localStorage.setItem(`codeck-${key}`, String(value));
}

// ── Signals ───────────────────────────────────────────────────────────────

export const terminalFontSize = signal(loadNum("font-size", 14));
export const terminalFontFamily = signal(
	load("font-family", "'JetBrains Mono', monospace"),
);
export const defaultModel = signal(load("default-model", "sonnet"));
export const sidebarPosition = signal<"left" | "right">(
	load("sidebar-position", "left") as "left" | "right",
);
export const sidebarAutoClose = signal(loadBool("sidebar-autoclose", false));
export const accentColor = signal(load("accent-color", "#6366f1"));
export const appLanguage = signal(load("language", "en"));

// ── Setters (update signal + persist) ─────────────────────────────────────

export function setFontSize(v: number): void {
	terminalFontSize.value = v;
	save("font-size", v);
	applyTerminalFont();
}

export function setFontFamily(v: string): void {
	terminalFontFamily.value = v;
	save("font-family", v);
	applyTerminalFont();
}

export function setDefaultModel(v: string): void {
	defaultModel.value = v;
	save("default-model", v);
}

export function setSidebarPosition(v: "left" | "right"): void {
	sidebarPosition.value = v;
	save("sidebar-position", v);
}

export function setSidebarAutoClose(v: boolean): void {
	sidebarAutoClose.value = v;
	save("sidebar-autoclose", v);
}

export function setAccentColor(hex: string): void {
	accentColor.value = hex;
	save("accent-color", hex);
	applyAccentColor(hex);
}

export function setAppLanguage(v: string): void {
	appLanguage.value = v;
	save("language", v);
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

// ── Boot-time: apply all stored settings ──────────────────────────────────

export function applyStoredSettings(): void {
	const hex = accentColor.value;
	if (hex !== "#6366f1") applyAccentColor(hex);

	if (sidebarPosition.value === "right") {
		document.querySelector(".app-layout")?.classList.add("sidebar-right");
	}
}
