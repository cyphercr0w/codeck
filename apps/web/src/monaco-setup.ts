/**
 * Monaco editor setup — worker wiring for Vite + a filename→language map.
 * Imported dynamically by EditorSection so Monaco lands in its own lazy chunk.
 */
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Vite bundles each `?worker` import as a standalone worker chunk.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
	getWorker(_workerId: string, label: string) {
		if (label === "json") return new jsonWorker();
		if (label === "css" || label === "scss" || label === "less") return new cssWorker();
		if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
		if (label === "typescript" || label === "javascript") return new tsWorker();
		return new editorWorker();
	},
};

const EXT_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json",
	css: "css", scss: "scss", less: "less",
	html: "html", htm: "html", vue: "html", svelte: "html",
	md: "markdown", markdown: "markdown",
	py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
	cs: "csharp", php: "php", swift: "swift", kt: "kotlin",
	sh: "shell", bash: "shell", zsh: "shell",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
	sql: "sql", xml: "xml", dockerfile: "dockerfile", graphql: "graphql", gql: "graphql",
};

export function languageForPath(path: string): string {
	const name = path.split("/").pop() || "";
	if (/^dockerfile$/i.test(name)) return "dockerfile";
	if (name.startsWith(".env")) return "ini";
	const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
	return EXT_LANG[ext] || "plaintext";
}

export { monaco };
