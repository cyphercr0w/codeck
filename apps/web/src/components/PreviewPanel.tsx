/**
 * PreviewPanel — Live localhost preview via subdomain proxy iframe.
 *
 * The iframe loads from a subdomain (p{port}.hostname or preview-{port}.localhost)
 * which is proxied by the subdomain middleware in the backend. All root-absolute
 * paths resolve correctly because the iframe has its own origin.
 *
 * For self-hosted without wildcard DNS, falls back to dedicated-port proxy.
 */
import { useState, useRef } from "preact/hooks";
import { previewPort, previewUrl, previewMode } from "../state/store";
import { IconRefresh, IconX, IconPlay, IconExternalLink } from "./Icons";
import { buildPreviewUrl } from "../utils/preview-url";

export function PreviewPanel() {
	const inputUrl = previewUrl.value;
	const setInputUrl = (v: string) => {
		previewUrl.value = v;
	};
	const activePort = previewPort.value;
	const setActivePort = (port: number | null) => {
		previewPort.value = port;
		previewMode.value = port !== null ? "split" : "hidden";
	};
	const [loading, setLoading] = useState(false);
	const [iframeReady, setIframeReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const iframeRef = useRef<HTMLIFrameElement>(null);

	function parseUrl(raw: string): { url: string; port: number | null } {
		let trimmed = raw.trim();
		if (!trimmed) return { url: "", port: null };
		if (!/^https?:\/\//.test(trimmed)) trimmed = `http://${trimmed}`;
		try {
			const parsed = new URL(trimmed);
			const host = parsed.hostname;
			if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
				return { url: trimmed, port: null };
			}
			const port = parseInt(parsed.port || "80", 10);
			return { url: trimmed, port };
		} catch {
			return { url: trimmed, port: null };
		}
	}

	async function handleOpen() {
		const { url, port } = parseUrl(inputUrl);
		if (!url) return;
		setInputUrl(url);
		setLoading(true);
		setError(null);

		if (!port || port === 80) {
			setError("Enter a localhost URL with a port (e.g., localhost:3000)");
			setLoading(false);
			return;
		}

		// Reachability check via path-based proxy (same origin, always works)
		try {
			const res = await fetch(`/preview-proxy/${port}/`, {
				method: "HEAD",
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok && res.status !== 304) {
				setError(`Port ${port} returned ${res.status}`);
				setLoading(false);
				return;
			}
		} catch {
			setError(`Nothing running on port ${port} — start a dev server first.`);
			setLoading(false);
			return;
		}

		setIframeReady(false);
		setActivePort(port);
		setLoading(false);
	}

	function handleRefresh() {
		if (iframeRef.current && activePort) {
			setIframeReady(false);
			iframeRef.current.src = buildPreviewUrl(activePort);
		}
	}

	function handleStop() {
		setActivePort(null);
		setIframeReady(false);
		setError(null);
	}

	function handleNavigate() {
		const { port } = parseUrl(inputUrl);
		if (port && port !== activePort) {
			setActivePort(null);
			setIframeReady(false);
			setError(null);
			// Open new port after state reset in next microtask
			Promise.resolve().then(() => handleOpen());
		} else if (iframeRef.current && activePort) {
			iframeRef.current.src = buildPreviewUrl(activePort);
		}
	}

	return (
		<div class="preview-panel">
			<div class="preview-toolbar">
				{activePort && (
					<>
						<button
							class="btn btn-xs btn-ghost"
							onClick={handleRefresh}
							title="Refresh"
						>
							<IconRefresh size={13} />
						</button>
						<a
							class="btn btn-xs btn-ghost"
							href={buildPreviewUrl(activePort)}
							target="_blank"
							rel="noopener noreferrer"
							title="Open in new window"
						>
							<IconExternalLink size={13} />
						</a>
					</>
				)}
				<input
					class="preview-url-input"
					type="text"
					placeholder="localhost:3000"
					value={inputUrl}
					onInput={(e) => setInputUrl((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							activePort ? handleNavigate() : handleOpen();
						}
					}}
				/>
				{activePort ? (
					<button
						class="btn btn-xs btn-ghost danger"
						onClick={handleStop}
						title="Stop"
					>
						<IconX size={13} />
					</button>
				) : (
					<button
						class="btn btn-xs btn-primary"
						onClick={handleOpen}
						disabled={loading || !inputUrl.trim()}
					>
						{loading ? <span class="spinner-sm" /> : <IconPlay size={13} />}
						Open
					</button>
				)}
			</div>

			{error && <div class="preview-error">{error}</div>}

			{activePort ? (
				<div class="preview-viewport">
					{!iframeReady && (
						<div class="preview-loading">
							<span class="spinner-sm" />
							<span>Loading preview...</span>
						</div>
					)}
					<iframe
						ref={iframeRef}
						class="preview-iframe"
						style={{ opacity: iframeReady ? 1 : 0 }}
						src={buildPreviewUrl(activePort)}
						title="Site preview"
						onLoad={() => setIframeReady(true)}
					/>
				</div>
			) : (
				!error && (
					<div class="preview-empty">
						<p>Enter a localhost URL to preview</p>
						<p class="preview-hint">
							When the agent starts a dev server, it will appear here
							automatically.
						</p>
					</div>
				)
			)}
		</div>
	);
}
