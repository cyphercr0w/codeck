import { useEffect, useState, useRef } from "preact/hooks";
import {
	playwrightUrl, playwrightActive,
	sessions, activeSessionId, showToast,
	type TerminalSession,
} from "../state/store";
import { setPlaywrightFrameHandler, wsSend } from "../ws";
import { apiFetch } from "../api";
import { IconX } from "./Icons";

interface InspectedEl { tag: string; selector: string; outerHTML: string; url: string; }
interface Pin { xPct: number; yPct: number; el: InspectedEl | null; note: string; loading: boolean; }

const clean = (s: string): string => (s || "").replace(/\s+/g, " ").trim();

export function PlaywrightPreview() {
	const [frameSrc, setFrameSrc] = useState<string | null>(null);
	const [designMode, setDesignMode] = useState(false);
	const [pin, setPin] = useState<Pin | null>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const url = playwrightUrl.value;

	useEffect(() => {
		setPlaywrightFrameHandler((data) => {
			setFrameSrc("data:image/jpeg;base64," + data);
		});
		apiFetch("/api/preview/playwright/frame")
			.then((r) => r.json())
			.then((res: { data: string | null }) => {
				if (res.data) setFrameSrc("data:image/jpeg;base64," + res.data);
			})
			.catch(() => {});
		return () => setPlaywrightFrameHandler(null);
	}, []);

	function handleClose() {
		playwrightActive.value = false;
	}

	async function handleFrameClick(e: MouseEvent) {
		if (!designMode) return;
		const img = imgRef.current;
		if (!img) return;
		const rect = img.getBoundingClientRect();
		const xPct = ((e.clientX - rect.left) / rect.width) * 100;
		const yPct = ((e.clientY - rect.top) / rect.height) * 100;
		// Map the on-screen click into the frame's natural (page) pixel space.
		const nx = (xPct / 100) * (img.naturalWidth || rect.width);
		const ny = (yPct / 100) * (img.naturalHeight || rect.height);
		setPin({ xPct, yPct, el: null, note: "", loading: true });
		try {
			const res = await apiFetch("/api/preview/playwright/inspect", {
				method: "POST",
				body: JSON.stringify({ x: nx, y: ny }),
			});
			const el = res.ok ? ((await res.json()) as InspectedEl) : null;
			setPin((p) => (p ? { ...p, el, loading: false } : p));
		} catch {
			setPin((p) => (p ? { ...p, loading: false } : p));
		}
	}

	function sendDesignFeedback() {
		if (!pin) return;
		const agentSessions = sessions.value.filter((s: TerminalSession) => s.type === "agent");
		const sid = agentSessions.find((s) => s.id === activeSessionId.value)?.id || agentSessions[0]?.id;
		if (!sid) { showToast("Open a Terminal (agent) session first", "error"); return; }
		if (!pin.note.trim()) { showToast("Add a note first", "error"); return; }
		const el = pin.el;
		const target = el ? (el.selector || el.tag) : `page location ${Math.round(pin.xPct)}%,${Math.round(pin.yPct)}%`;
		const snippet = el?.outerHTML ? ` (element: ${clean(el.outerHTML).slice(0, 200)})` : "";
		const prompt = `[Design feedback] On ${el?.url || url || "the current page"}, the element ${target} — ${clean(pin.note)}. Locate this element in the code and update its HTML/CSS accordingly.${snippet}`;
		wsSend({ type: "console:input", sessionId: sid, data: prompt + "\r" });
		showToast("Design feedback sent to the agent", "success");
		setPin(null);
	}

	return (
		<div class="preview-panel">
			<div class="preview-toolbar">
				<div class="playwright-badge">Agent Browser</div>
				<div class="playwright-url" title={url}>{url || "Waiting..."}</div>
				<button
					class={`btn btn-xs ${designMode ? "btn-primary" : "btn-ghost"}`}
					onClick={() => { setDesignMode((d) => !d); setPin(null); }}
					title="Design Mode — click an element to send feedback to the agent"
				>
					Design
				</button>
				<button class="btn btn-xs btn-ghost danger" onClick={handleClose} title="Close">
					<IconX size={13} />
				</button>
			</div>
			{frameSrc ? (
				<div class="preview-viewport" style="position: relative">
					<img
						ref={imgRef}
						src={frameSrc}
						class="playwright-frame"
						alt="Agent browser view"
						style={designMode ? "cursor: crosshair" : undefined}
						onClick={handleFrameClick}
					/>
					{designMode && (
						<div style="position: absolute; top: 8px; left: 8px; background: var(--accent); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 4px; pointer-events: none">
							Design Mode — click an element
						</div>
					)}
					{pin && (
						<>
							<div style={`position: absolute; left: ${pin.xPct}%; top: ${pin.yPct}%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border: 2px solid var(--accent); border-radius: 50%; background: rgba(88,166,255,0.3); pointer-events: none`} />
							<div
								class="dash-card"
								style={`position: absolute; left: ${Math.min(pin.xPct, 60)}%; top: calc(${pin.yPct}% + 12px); width: 300px; max-width: 90%; padding: 10px; z-index: 5`}
								onClick={(e) => e.stopPropagation()}
							>
								<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px; word-break: break-all">
									{pin.loading ? "Inspecting element…" : pin.el ? <code>{pin.el.selector || pin.el.tag || "element"}</code> : "No element resolved — feedback will use the click position."}
								</div>
								<textarea
									class="input"
									placeholder="What should change here? (e.g. make this button larger and blue)"
									value={pin.note}
									rows={2}
									style="resize: vertical; margin-bottom: 8px"
									onInput={(e) => setPin((p) => (p ? { ...p, note: (e.target as HTMLTextAreaElement).value } : p))}
								/>
								<div style="display: flex; gap: 6px; justify-content: flex-end">
									<button class="btn btn-xs btn-secondary" onClick={() => setPin(null)}>Cancel</button>
									<button class="btn btn-xs btn-primary" disabled={pin.loading} onClick={sendDesignFeedback}>Send to agent</button>
								</div>
							</div>
						</>
					)}
				</div>
			) : (
				<div class="playwright-placeholder">
					<div class="playwright-badge" style={{ fontSize: "13px" }}>Agent Browser</div>
					<span>Waiting for agent to browse...</span>
				</div>
			)}
		</div>
	);
}
