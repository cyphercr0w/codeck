/**
 * MobilePreviewSheet — Fullscreen overlay for preview on mobile devices.
 * Shows a floating indicator pill when minimized, expands to fullscreen on tap.
 */
import { previewPort, previewUrl, mobilePreviewOpen } from "../state/store";
import { buildPreviewUrl } from "../utils/preview-url";
import { IconX, IconChevronDown, IconRefresh } from "./Icons";
import { useRef, useState } from "preact/hooks";

export function MobilePreviewSheet() {
	const port = previewPort.value;
	const open = mobilePreviewOpen.value;
	const [iframeReady, setIframeReady] = useState(false);
	const [editingUrl, setEditingUrl] = useState(false);
	const [urlInput, setUrlInput] = useState("");
	const iframeRef = useRef<HTMLIFrameElement>(null);

	if (!port && !open) return null;

	return (
		<>
			{/* Floating indicator when minimized */}
			{port && !open && (
				<button
					class="mobile-preview-indicator"
					onClick={() => {
						mobilePreviewOpen.value = true;
					}}
				>
					<span class="mobile-preview-indicator-dot" />
					<span>:{port}</span>
				</button>
			)}

			{/* Full overlay sheet */}
			{open && port && (
				<div class="mobile-preview-sheet">
					<div class="mobile-preview-sheet-header">
						{editingUrl ? (
							<form
								class="mobile-preview-url-form"
								onSubmit={(e) => {
									e.preventDefault();
									const trimmed = urlInput.trim();
									if (!trimmed) {
										setEditingUrl(false);
										return;
									}
									// Parse port from URL like "localhost:3000" or "http://localhost:3000/path"
									let parsed = trimmed;
									if (!/^https?:\/\//.test(parsed)) parsed = `http://${parsed}`;
									try {
										const url = new URL(parsed);
										const newPort = parseInt(url.port || "80", 10);
										if (newPort && newPort !== 80) {
											previewPort.value = newPort;
											previewUrl.value = parsed;
										}
									} catch {
										/* ignore invalid */
									}
									setEditingUrl(false);
								}}
							>
								<input
									class="mobile-preview-url-input"
									type="text"
									value={urlInput}
									onInput={(e) =>
										setUrlInput((e.target as HTMLInputElement).value)
									}
									placeholder="localhost:3000"
									autoFocus
									onBlur={() => setEditingUrl(false)}
								/>
							</form>
						) : (
							<span
								class="mobile-preview-sheet-url"
								onClick={() => {
									setUrlInput(previewUrl.value || `localhost:${port}`);
									setEditingUrl(true);
								}}
							>
								{previewUrl.value || `localhost:${port}`}
							</span>
						)}
						<button
							class="btn btn-xs btn-ghost"
							onClick={() => {
								if (iframeRef.current) {
									iframeRef.current.src = buildPreviewUrl(port);
								}
							}}
							title="Refresh"
						>
							<IconRefresh size={16} />
						</button>
						<button
							class="btn btn-xs btn-ghost"
							onClick={() => {
								mobilePreviewOpen.value = false;
							}}
							title="Minimize"
						>
							<IconChevronDown size={16} />
						</button>
						<button
							class="btn btn-xs btn-ghost danger"
							onClick={() => {
								mobilePreviewOpen.value = false;
								previewPort.value = null;
							}}
							title="Close preview"
						>
							<IconX size={16} />
						</button>
					</div>
					<iframe
						ref={iframeRef}
						class="mobile-preview-sheet-iframe"
						src={buildPreviewUrl(port)}
						title="Site preview"
						onLoad={() => setIframeReady(true)}
					/>
				</div>
			)}
		</>
	);
}
