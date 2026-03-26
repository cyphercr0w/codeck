/** Build the iframe URL via subdomain or path-based fallback. */
export function buildPreviewUrl(port: number): string {
	const { protocol, hostname } = window.location;
	const portSuffix = window.location.port ? `:${window.location.port}` : "";
	// IP addresses can't use subdomains — fall back to path-based proxy
	if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
		return `/preview-proxy/${port}/`;
	}
	// localhost: preview-{port}.localhost (Chrome/Firefox resolve *.localhost)
	if (hostname === "localhost") {
		return `${protocol}//preview-${port}.${hostname}${portSuffix}/`;
	}
	// Production: p{port}.{baseDomain} — strip leading subdomain
	// dev.codeck.xyz → p4321.codeck.xyz (single-level, covered by Universal SSL)
	const parts = hostname.split(".");
	const baseDomain = parts.length > 2 ? parts.slice(-2).join(".") : hostname;
	return `${protocol}//p${port}.${baseDomain}/`;
}
