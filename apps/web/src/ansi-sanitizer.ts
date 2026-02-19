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
  // Fast path: no ESC byte means no ANSI sequences to strip
  if (data.indexOf('\x1b') === -1) return data;

  return data
    // OSC (Operating System Command): ESC ] ... BEL or ESC ] ... ST (ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS (Device Control String): ESC P ... ST (ESC \)
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    // PM (Privacy Message): ESC ^ ... ST (ESC \)
    .replace(/\x1b\^[^\x1b]*\x1b\\/g, '')
    // APC (Application Program Command): ESC _ ... ST (ESC \)
    .replace(/\x1b_[^\x1b]*\x1b\\/g, '');
  // CSI (Control Sequence Introducer) and SGR (Select Graphic Rendition) are ALLOWED —
  // these provide colors, bold, underline, cursor movement, etc.
}
