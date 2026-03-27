/**
 * ChangesPanel — GitHub-style diff viewer for file changes in the active session.
 *
 * Shows a file list with addition/deletion counts, and a detailed diff view
 * with red (deleted) and green (added) lines when a file is selected.
 */

import {
	sessionChanges,
	selectedChangePath,
	changesOpen,
	type FileDiffData,
} from "../state/store";

export function ChangesPanel() {
	const changes = sessionChanges.value;
	const selected = selectedChangePath.value;
	const selectedDiff = changes.find((d) => d.path === selected);

	if (changes.length === 0) {
		return (
			<div class="changes-panel">
				<div class="changes-empty">
					<p>No file changes yet</p>
					<p class="changes-hint">
						Changes will appear here as the agent edits files
					</p>
				</div>
			</div>
		);
	}

	// Summary
	let totalAdd = 0;
	let totalDel = 0;
	for (const d of changes) {
		totalAdd += d.additions;
		totalDel += d.deletions;
	}

	return (
		<div class="changes-panel">
			{/* File list header */}
			<div class="changes-header">
				<span class="changes-title">
					{changes.length} file{changes.length !== 1 ? "s" : ""} changed
				</span>
				<span class="changes-summary">
					<span class="changes-add">+{totalAdd}</span>
					<span class="changes-del">-{totalDel}</span>
				</span>
			</div>

			{/* File list */}
			<div class="changes-file-list">
				{changes.map((diff) => (
					<FileRow
						key={diff.path}
						diff={diff}
						isSelected={diff.path === selected}
						onSelect={() => {
							selectedChangePath.value =
								diff.path === selected ? null : diff.path;
						}}
					/>
				))}
			</div>

			{/* Diff view */}
			{selectedDiff && <DiffView diff={selectedDiff} />}
		</div>
	);
}

function FileRow({
	diff,
	isSelected,
	onSelect,
}: {
	diff: FileDiffData;
	isSelected: boolean;
	onSelect: () => void;
}) {
	const parts = diff.path.split("/");
	const fileName = parts.pop() || diff.path;
	const dirPath = parts.join("/");
	const total = diff.additions + diff.deletions;
	const addPct = total > 0 ? Math.round((diff.additions / total) * 100) : 0;

	return (
		<div
			class={`changes-file-row${isSelected ? " selected" : ""}`}
			onClick={onSelect}
		>
			<span class={`changes-file-status changes-file-${diff.status}`}>
				{diff.status === "added" ? "A" : diff.status === "deleted" ? "D" : "M"}
			</span>
			<span class="changes-file-path">
				{dirPath && <span class="changes-file-dir">{dirPath}/</span>}
				<span class="changes-file-name">{fileName}</span>
			</span>
			<span class="changes-file-stats">
				{diff.additions > 0 && (
					<span class="changes-add">+{diff.additions}</span>
				)}
				{diff.deletions > 0 && (
					<span class="changes-del">-{diff.deletions}</span>
				)}
			</span>
			{/* Mini bar chart like GitHub */}
			<span class="changes-file-bar">
				{Array.from({ length: Math.min(5, Math.ceil(total / 10) || 1) }).map(
					(_, i) => {
						const isGreen =
							i <
							Math.round(
								(addPct / 100) * Math.min(5, Math.ceil(total / 10) || 1),
							);
						return (
							<span
								key={i}
								class={`changes-bar-dot ${isGreen ? "add" : "del"}`}
							/>
						);
					},
				)}
			</span>
		</div>
	);
}

function DiffView({ diff }: { diff: FileDiffData }) {
	return (
		<div class="changes-diff-view">
			<div class="changes-diff-header">
				<span class="changes-diff-path">{diff.path}</span>
				<span class="changes-diff-stats">
					<span class="changes-add">+{diff.additions}</span>
					<span class="changes-del">-{diff.deletions}</span>
				</span>
			</div>
			{diff.hunks.map((hunk, hi) => (
				<div key={hi} class="changes-hunk">
					<div class="changes-hunk-header">
						@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{" "}
						@@
					</div>
					{hunk.lines.map((line, li) => (
						<div key={li} class={`changes-line changes-line-${line.type}`}>
							<span class="changes-line-no">
								{line.type === "add"
									? ""
									: String(line.oldLineNo ?? "").padStart(4)}
							</span>
							<span class="changes-line-no">
								{line.type === "del"
									? ""
									: String(line.newLineNo ?? "").padStart(4)}
							</span>
							<span class="changes-line-sign">
								{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
							</span>
							<span class="changes-line-text">{line.content}</span>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

/** Toggle button for the terminal tab bar */
export function ChangesToggle() {
	const count = sessionChanges.value.length;
	const open = changesOpen.value;

	return (
		<button
			class={`terminal-tab-new changes-toggle${open ? " active" : ""}${count > 0 ? " has-changes" : ""}`}
			onClick={() => {
				changesOpen.value = !open;
			}}
			title={count > 0 ? `${count} files changed` : "No changes"}
			aria-label="Toggle changes panel"
		>
			<svg
				width={14}
				height={14}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M12 20h9" />
				<path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
			</svg>
			{count > 0 && <span class="changes-badge">{count}</span>}
		</button>
	);
}
