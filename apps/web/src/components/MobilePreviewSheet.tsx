/**
 * MobilePreviewSheet — Fullscreen overlay for preview on mobile devices.
 * Shows a floating indicator pill when minimized, expands to fullscreen on tap.
 */
import { previewPort, previewUrl, mobilePreviewOpen } from "../state/store";
import { buildPreviewUrl } from "../utils/preview-url";
import { IconX, IconChevronDown } from "./Icons";
import { useRef, useState } from "preact/hooks";

export function MobilePreviewSheet() {
	const port = previewPort.value;
	const open = mobilePreviewOpen.value;
	const [iframeReady, setIframeReady] = useState(false);
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
						<span class="mobile-preview-sheet-url">
							{previewUrl.value || `localhost:${port}`}
						</span>
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
