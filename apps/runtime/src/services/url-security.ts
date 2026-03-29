import { lookup } from "dns/promises";

// ── SSRF protection: block requests to private/reserved IP ranges ──

export function isPrivateIP(ip: string): boolean {
	// Normalize IPv6-mapped IPv4 (e.g., ::ffff:127.0.0.1 → 127.0.0.1)
	// Lowercase early so IPv6 unique-local checks (fc/fd) work regardless of case
	const normalized = ip.replace(/^::ffff:/i, "").toLowerCase();

	// IPv4 private/reserved ranges
	const parts = normalized.split(".").map(Number);
	if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255)) {
		if (parts[0] === 127) return true; // 127.0.0.0/8 loopback
		if (parts[0] === 10) return true; // 10.0.0.0/8 private
		if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12 private
		if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16 private
		if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 link-local
		if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
		if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true; // 198.18.0.0/15 benchmark
		if (parts[0] >= 240) return true; // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
		if (parts[0] === 0) return true; // 0.0.0.0/8
	}

	// IPv6 loopback and link-local
	if (normalized === "::1" || normalized === "::") return true;
	if (normalized.startsWith("fe80:")) return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

	return false;
}

export async function assertNotPrivateURL(urlStr: string): Promise<void> {
	const parsed = new URL(urlStr);
	const hostname = parsed.hostname;
	// Reject IP literals directly
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")) {
		const ip = hostname.replace(/^\[|\]$/g, "");
		if (isPrivateIP(ip)) {
			throw new Error("Requests to private/internal IP addresses are blocked");
		}
	}
	// Resolve hostname and check ALL addresses (IPv4 + IPv6) to prevent
	// attackers from having a public A record but a private AAAA record.
	// Note: TOCTOU/DNS-rebinding risk remains (fetch does its own resolution).
	// Full mitigation requires a custom DNS-pinning fetch agent.
	const results = await lookup(hostname, { all: true });
	for (const { address } of results) {
		if (isPrivateIP(address)) {
			throw new Error("Requests to private/internal IP addresses are blocked");
		}
	}
}
