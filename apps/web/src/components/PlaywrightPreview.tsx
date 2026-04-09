import { useEffect, useRef, useState } from "preact/hooks";
import { playwrightUrl, playwrightActive } from "../state/store";
import { setPlaywrightFrameHandler } from "../ws";
import { apiFetch } from "../api";
import { IconX } from "./Icons";

export function PlaywrightPreview() {
	const imgRef = useRef<HTMLImageElement>(null);
	const [hasFrame, setHasFrame] = useState(false);
	const url = playwrightUrl.value;

	useEffect(() => {
		setPlaywrightFrameHandler((data) => {
			if (imgRef.current) {
				imgRef.current.src = "data:image/jpeg;base64," + data;
				setHasFrame(true);
			}
		});

		// Fetch cached frame for late-joining clients (static pages don't emit new frames)
		apiFetch("/api/preview/playwright/frame")
			.then((r) => r.json())
			.then((res: { data: string | null }) => {
				if (res.data && imgRef.current) {
					imgRef.current.src = "data:image/jpeg;base64," + res.data;
					setHasFrame(true);
				}
			})
			.catch(() => {});

		return () => setPlaywrightFrameHandler(null);
	}, []);

	function handleClose() {
		playwrightActive.value = false;
	}

	return (
		<div class="preview-panel">
			<div class="preview-toolbar">
				<div class="playwright-badge">Agent Browser</div>
				<div class="playwright-url" title={url}>
					{url || "Waiting..."}
				</div>
				<button
					class="btn btn-xs btn-ghost danger"
					onClick={handleClose}
					title="Close"
				>
					<IconX size={13} />
				</button>
			</div>
			{hasFrame ? (
				<div class="preview-viewport">
					<img ref={imgRef} class="playwright-frame" alt="Agent browser view" />
				</div>
			) : (
				<div class="playwright-placeholder">
					<div class="playwright-badge" style={{ fontSize: "13px" }}>
						Agent Browser
					</div>
					<span>Waiting for agent to browse...</span>
				</div>
			)}
		</div>
	);
}
