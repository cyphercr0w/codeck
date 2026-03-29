/**
 * Build the iframe URL via subdomain: {port}.{domain}
 *
 * Examples:
 *   localhost      → http://5173.localhost/
 *   dev.codeck.xyz → https://5173.codeck.xyz/
 *   192.168.1.100  → /preview-proxy/5173/ (IP fallback)
 */
export function buildPreviewUrl(port: number): string {
	const { protocol, hostname } = window.location;
	const portSuffix = window.location.port ? `:${window.location.port}` : "";
	// IP addresses can't use subdomains — fall back to path-based proxy
	if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
		return `/preview-proxy/${port}/`;
	}
	// Consistent format: {port}.{baseDomain}
	// localhost → 5173.localhost
	// dev.codeck.xyz → 5173.codeck.xyz (single-level, covered by Universal SSL)
	const parts = hostname.split(".");
	const baseDomain = parts.length > 2 ? parts.slice(-2).join(".") : hostname;
	return `${protocol}//${port}.${baseDomain}${portSuffix}/`;
}
