import { useEffect, useRef, useState } from "preact/hooks";
import type * as Monaco from "monaco-editor";
import { apiFetch } from "../api";
import { workspacePath, showToast } from "../state/store";
import {
	IconFolder, IconChevronRight, IconChevronDown, IconRefresh, IconX, IconSave, getFileIcon,
} from "./Icons";

interface FileItem { name: string; isDirectory: boolean; size: number; }
interface Tab { path: string; dirty: boolean; }
interface SearchHit { file: string; line: number; text: string; }

const LANGS = [
	"plaintext", "typescript", "javascript", "json", "html", "css", "scss", "less",
	"markdown", "python", "go", "rust", "java", "c", "cpp", "csharp", "php", "ruby",
	"shell", "yaml", "sql", "xml", "dockerfile", "ini",
];

const sortItems = (items: FileItem[]): FileItem[] =>
	[...items].sort((a, b) =>
		a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));

export function EditorSection() {
	const [ready, setReady] = useState(false);
	const [loadErr, setLoadErr] = useState("");
	const [childrenMap, setChildrenMap] = useState<Record<string, FileItem[]>>({});
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [tabs, setTabs] = useState<Tab[]>([]);
	const [active, setActive] = useState<string | null>(null);
	const [activeLang, setActiveLang] = useState<string>("plaintext");
	// Search-in-files
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchHit[]>([]);
	const [searching, setSearching] = useState(false);
	const [mode, setMode] = useState<"tree" | "search">("tree");

	const containerRef = useRef<HTMLDivElement>(null);
	const monacoRef = useRef<typeof Monaco | null>(null);
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const modelsRef = useRef<Map<string, Monaco.editor.ITextModel>>(new Map());
	const listenersRef = useRef<Map<string, Monaco.IDisposable>>(new Map());
	const openingRef = useRef<Set<string>>(new Set());
	const saveRef = useRef<() => void>(() => {});

	useEffect(() => {
		let disposed = false;
		(async () => {
			try {
				const mod = await import("../monaco-setup");
				if (disposed || !containerRef.current) return;
				monacoRef.current = mod.monaco;
				editorRef.current = mod.monaco.editor.create(containerRef.current, {
					value: "",
					language: "plaintext",
					theme: "vs-dark",
					automaticLayout: true,
					minimap: { enabled: true },
					fontSize: 13,
					scrollBeyondLastLine: false,
					tabSize: 2,
				});
				editorRef.current.addCommand(
					mod.monaco.KeyMod.CtrlCmd | mod.monaco.KeyCode.KeyS,
					() => saveRef.current(),
				);
				setReady(true);
				loadDir("");
			} catch (e) {
				setLoadErr((e as Error)?.message || "Failed to load editor");
			}
		})();
		return () => {
			disposed = true;
			listenersRef.current.forEach((d) => d.dispose());
			modelsRef.current.forEach((m) => m.dispose());
			editorRef.current?.dispose();
			listenersRef.current.clear();
			modelsRef.current.clear();
		};
	}, []);

	async function loadDir(path: string) {
		try {
			const res = await apiFetch("/api/files?path=" + encodeURIComponent(path));
			const data = await res.json();
			if (data.success) setChildrenMap((m) => ({ ...m, [path]: sortItems(data.items) }));
		} catch { /* ignore */ }
	}

	function toggleDir(path: string) {
		const willExpand = !expanded[path];
		setExpanded((e) => ({ ...e, [path]: willExpand }));
		if (willExpand && !childrenMap[path]) loadDir(path);
	}

	async function openFile(path: string, line?: number) {
		const monaco = monacoRef.current;
		const editor = editorRef.current;
		if (!monaco || !editor) return;

		let model = modelsRef.current.get(path);
		if (!model) {
			if (openingRef.current.has(path)) return; // in-flight guard (double-click / dup URI)
			openingRef.current.add(path);
			try {
				const res = await apiFetch("/api/files/read?path=" + encodeURIComponent(path));
				const data = await res.json();
				if (!data.success) { showToast(data.error || "Could not read file", "error"); return; }
				// Another concurrent open may have created it while we awaited.
				model = modelsRef.current.get(path);
				if (!model) {
					const { languageForPath } = await import("../monaco-setup");
					model = monaco.editor.createModel(data.content, languageForPath(path), monaco.Uri.file("/" + path));
					modelsRef.current.set(path, model);
					const sub = model.onDidChangeContent(() => {
						setTabs((t) => t.map((tab) => (tab.path === path ? { ...tab, dirty: true } : tab)));
					});
					listenersRef.current.set(path, sub);
					setTabs((t) => (t.some((tab) => tab.path === path) ? t : [...t, { path, dirty: false }]));
				}
			} catch { showToast("Could not read file", "error"); return; }
			finally { openingRef.current.delete(path); }
		}
		editor.setModel(model);
		setActive(path);
		setActiveLang(model.getLanguageId());
		if (line && line > 0) {
			editor.revealLineInCenter(line);
			editor.setPosition({ lineNumber: line, column: 1 });
		}
		editor.focus();
	}

	async function saveFile(path: string) {
		const model = modelsRef.current.get(path);
		if (!model) return;
		try {
			const res = await apiFetch("/api/files/write", {
				method: "PUT",
				body: JSON.stringify({ path, content: model.getValue() }),
			});
			const data = await res.json();
			if (data.success) {
				setTabs((t) => t.map((tab) => (tab.path === path ? { ...tab, dirty: false } : tab)));
				showToast("Saved " + (path.split("/").pop() || path), "success");
			} else showToast(data.error || "Save failed", "error");
		} catch { showToast("Save failed", "error"); }
	}

	saveRef.current = () => { if (active) saveFile(active); };

	function formatActive() {
		editorRef.current?.getAction("editor.action.formatDocument")?.run();
	}

	function changeLang(lang: string) {
		const monaco = monacoRef.current;
		if (!monaco || !active) return;
		const model = modelsRef.current.get(active);
		if (!model) return;
		monaco.editor.setModelLanguage(model, lang);
		setActiveLang(lang);
	}

	function closeTab(path: string, e?: MouseEvent) {
		e?.stopPropagation();
		listenersRef.current.get(path)?.dispose();
		listenersRef.current.delete(path);
		modelsRef.current.get(path)?.dispose();
		modelsRef.current.delete(path);
		const remaining = tabs.filter((t) => t.path !== path);
		setTabs(remaining);
		if (active === path) {
			const next = remaining[remaining.length - 1];
			if (next) openFile(next.path);
			else { setActive(null); editorRef.current?.setModel(null); }
		}
	}

	async function runSearch() {
		const q = query.trim();
		if (q.length < 2) { setResults([]); setMode("tree"); return; }
		setSearching(true);
		setMode("search");
		try {
			const res = await apiFetch("/api/files/search?q=" + encodeURIComponent(q));
			const data = await res.json();
			setResults(data.matches || []);
		} catch { setResults([]); }
		setSearching(false);
	}

	function renderTree(dir: string, depth: number) {
		const items = childrenMap[dir];
		if (!items) return null;
		return items.map((item) => {
			const path = dir ? dir + "/" + item.name : item.name;
			const isOpen = expanded[path];
			return (
				<div key={path}>
					<div
						class={`editor-tree-row${active === path ? " active" : ""}`}
						style={`padding-left: ${8 + depth * 12}px`}
						onClick={() => (item.isDirectory ? toggleDir(path) : openFile(path))}
						title={item.name}
					>
						<span class="editor-tree-caret">
							{item.isDirectory ? (isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />) : <span style="display:inline-block;width:12px" />}
						</span>
						<span class="editor-tree-icon">
							{item.isDirectory ? <IconFolder size={14} /> : getFileIcon(item.name, 14)}
						</span>
						<span class="editor-tree-name">{item.name}</span>
					</div>
					{item.isDirectory && isOpen && renderTree(path, depth + 1)}
				</div>
			);
		});
	}

	return (
		<div class="content-section" style="height: 100%">
			<div class="editor-ide">
				<div class="editor-tree">
					<div class="editor-tree-header">
						<span style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px">
							<IconFolder size={13} /> {workspacePath.value.split("/").pop() || "workspace"}
						</span>
						<button class="btn btn-xs btn-ghost" title="Refresh" onClick={() => { setChildrenMap({}); setExpanded({}); loadDir(""); }}>
							<IconRefresh size={13} />
						</button>
					</div>
					<div style="padding: 6px 8px; border-bottom: 1px solid var(--border)">
						<input
							class="input"
							style="width:100%;padding:4px 8px;font-size:12px"
							placeholder="Search in files… (Enter)"
							value={query}
							onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
							onKeyDown={(e) => { if (e.key === "Enter") runSearch(); if (e.key === "Escape") { setQuery(""); setResults([]); setMode("tree"); } }}
						/>
					</div>
					<div class="editor-tree-body">
						{mode === "search" ? (
							searching ? <div class="editor-tree-loading">Searching…</div>
								: results.length === 0 ? <div class="editor-tree-loading">No matches</div>
									: results.map((h, i) => (
										<div key={i} class="editor-tree-row" style="padding-left:8px;display:block" onClick={() => openFile(h.file, h.line)} title={`${h.file}:${h.line}`}>
											<div style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis">{h.file.split("/").pop()}:{h.line}</div>
											<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{h.text.trim()}</div>
										</div>
									))
						) : (
							childrenMap[""] ? renderTree("", 0) : <div class="editor-tree-loading">Loading…</div>
						)}
					</div>
				</div>

				<div class="editor-main">
					<div class="editor-tabs">
						{tabs.map((tab) => (
							<div
								key={tab.path}
								class={`editor-tab${active === tab.path ? " active" : ""}`}
								onClick={() => openFile(tab.path)}
								title={tab.path}
							>
								<span class="editor-tab-icon">{getFileIcon(tab.path, 13)}</span>
								<span class="editor-tab-name">{tab.path.split("/").pop()}</span>
								{tab.dirty && <span class="editor-tab-dirty" title="Unsaved">●</span>}
								<button class="editor-tab-close" onClick={(e) => closeTab(tab.path, e)}><IconX size={11} /></button>
							</div>
						))}
						{active && (
							<div style="margin-left:auto;display:flex;align-items:center;gap:4px;padding-right:6px">
								<select class="input" style="width:auto;padding:2px 6px;font-size:11px" value={activeLang} onChange={(e) => changeLang((e.target as HTMLSelectElement).value)} title="Language">
									{LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
								</select>
								<button class="btn btn-xs btn-ghost" title="Format document" onClick={formatActive}>Format</button>
								<button class="btn btn-xs btn-ghost" title="Save (Ctrl+S)" onClick={() => saveFile(active)}><IconSave size={13} /></button>
							</div>
						)}
					</div>
					<div class="editor-monaco-wrap">
						<div class="editor-monaco" ref={containerRef} />
						{(!ready || tabs.length === 0) && (
							<div class="editor-placeholder">{loadErr ? `Editor failed: ${loadErr}` : !ready ? "Loading editor…" : "Select a file from the tree to start editing."}</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
