import { describe, it, expect } from "vitest";
import { sanitizeAnsiOutput } from "../../apps/web/src/ansi-sanitizer";

describe("sanitizeAnsiOutput", () => {
	// ── Fast path ──
	it("should pass through plain text unchanged", () => {
		expect(sanitizeAnsiOutput("hello world")).toBe("hello world");
	});

	// ── Allowed sequences ──
	it("should preserve CSI/SGR color codes", () => {
		const colored = "\x1b[32mgreen\x1b[0m";
		expect(sanitizeAnsiOutput(colored)).toBe(colored);
	});

	it("should preserve cursor movement sequences", () => {
		const cursor = "\x1b[2J\x1b[H";
		expect(sanitizeAnsiOutput(cursor)).toBe(cursor);
	});

	// ── 7-bit dangerous sequences ──
	it("should strip OSC with BEL terminator", () => {
		expect(sanitizeAnsiOutput("\x1b]0;evil title\x07")).toBe("");
	});

	it("should strip OSC with ST terminator", () => {
		expect(sanitizeAnsiOutput("\x1b]52;c;payload\x1b\\")).toBe("");
	});

	it("should strip DCS sequences", () => {
		expect(sanitizeAnsiOutput("\x1bPmalicious\x1b\\")).toBe("");
	});

	it("should strip PM sequences", () => {
		expect(sanitizeAnsiOutput("\x1b^private data\x1b\\")).toBe("");
	});

	it("should strip APC sequences", () => {
		expect(sanitizeAnsiOutput("\x1b_app command\x1b\\")).toBe("");
	});

	it("should preserve text around stripped sequences", () => {
		expect(sanitizeAnsiOutput("before\x1b]0;title\x07after")).toBe(
			"beforeafter",
		);
	});

	// ── 8-bit C1 control codes ──
	it("should strip C1 DCS (0x90) with ST terminator", () => {
		expect(sanitizeAnsiOutput("\x90payload\x9c")).toBe("");
	});

	it("should strip C1 OSC (0x9D) with ST terminator", () => {
		expect(sanitizeAnsiOutput("\x9d0;evil\x9c")).toBe("");
	});

	it("should strip C1 PM (0x9E) with ST terminator", () => {
		expect(sanitizeAnsiOutput("\x9eprivate\x9c")).toBe("");
	});

	it("should strip C1 APC (0x9F) with ST terminator", () => {
		expect(sanitizeAnsiOutput("\x9fcommand\x9c")).toBe("");
	});

	it("should strip lone C1 bytes without terminator", () => {
		expect(sanitizeAnsiOutput("a\x90b")).toBe("ab");
		expect(sanitizeAnsiOutput("a\x9db")).toBe("ab");
		expect(sanitizeAnsiOutput("a\x9eb")).toBe("ab");
		expect(sanitizeAnsiOutput("a\x9fb")).toBe("ab");
	});

	it("should preserve text around C1 sequences", () => {
		expect(sanitizeAnsiOutput("hello\x9d0;title\x9cworld")).toBe("helloworld");
	});

	// ── Mixed ──
	it("should handle mix of 7-bit and 8-bit dangerous sequences", () => {
		const input = "ok\x1b]0;title\x07\x9dpayload\x9c\x1b[32mgreen\x1b[0m";
		expect(sanitizeAnsiOutput(input)).toBe("ok\x1b[32mgreen\x1b[0m");
	});
});
