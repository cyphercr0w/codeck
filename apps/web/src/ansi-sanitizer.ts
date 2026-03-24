/**
 * Sanitize ANSI escape sequences to remove potentially dangerous codes.
 * Allows basic formatting (colors, bold, underline) via CSI/SGR sequences.
 * Blocks sequences known to be exploitable:
 * - OSC (Operating System Commands) — can set window title, clipboard, or execute commands
 * - DCS (Device Control Strings) — historical xterm.js vulnerability vector
 * - PM (Privacy Message) — information leakage vector
 * - APC (Application Program Command) — arbitrary code execution risk
 *
 * References:
 * - CVE-2025-30089 (gurk ANSI DoS)
 * - CVE-2025-67746 (Composer terminal ANSI injection)
 * - Trail of Bits: "Deceiving users with ANSI terminal codes in MCP" (April 2025)
 * - dgl.cx: "ANSI Terminal security in 2023 and finding 10 CVEs"
 */
export function sanitizeAnsiOutput(data: string): string {
	// Fast path: no ESC byte and no C1 bytes means nothing to strip
	if (data.indexOf("\x1b") === -1 && !/[\x80-\x9f]/.test(data)) return data;

	return (
		data
			// ── 7-bit ESC sequences ──
			// OSC (Operating System Command): ESC ] ... BEL or ESC ] ... ST (ESC \)
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			// DCS (Device Control String): ESC P ... ST (ESC \)
			.replace(/\x1bP[^\x1b]*\x1b\\/g, "")
			// PM (Privacy Message): ESC ^ ... ST (ESC \)
			.replace(/\x1b\^[^\x1b]*\x1b\\/g, "")
			// APC (Application Program Command): ESC _ ... ST (ESC \)
			.replace(/\x1b_[^\x1b]*\x1b\\/g, "")
			// ── 8-bit C1 control codes (single-byte equivalents) ──
			// Strip dangerous C1 codes: 0x90=DCS, 0x9D=OSC, 0x9E=PM, 0x9F=APC
			// These are single-byte alternatives to their ESC-prefixed versions
			// and can bypass 7-bit-only sanitizers for terminal injection.
			.replace(/[\x90\x9d\x9e\x9f][^\x9c]*\x9c/g, "") // C1 with ST (0x9C) terminator
			.replace(/[\x90\x9d\x9e\x9f]/g, "")
	); // lone C1 bytes (unterminated)
	// CSI (Control Sequence Introducer) and SGR (Select Graphic Rendition) are ALLOWED —
	// these provide colors, bold, underline, cursor movement, etc.
	// Note: 0x9B (CSI) is intentionally NOT stripped — it's the 8-bit CSI equivalent
	// and is used by some terminals for legitimate formatting.
}
