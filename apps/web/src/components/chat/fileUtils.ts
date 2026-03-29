import { showToast } from "../../state/store";

export const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".csv",
	".json",
	".xml",
	".html",
	".css",
	".js",
	".ts",
	".py",
	".sh",
	".yml",
	".yaml",
	".toml",
	".ini",
	".cfg",
	".log",
	".jsx",
	".tsx",
	".rs",
	".go",
	".java",
	".rb",
	".php",
	".sql",
	".env",
	".gitignore",
]);

export const TEXT_FILE_ACCEPT =
	".txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.py,.sh,.yml,.yaml,.toml,.ini,.cfg,.log,.jsx,.tsx,.rs,.go,.java,.rb,.php,.sql,.env,.gitignore";

export function isTextFile(file: File): boolean {
	if (file.type.startsWith("text/")) return true;
	if (file.type === "application/json" || file.type === "application/xml")
		return true;
	const ext = "." + file.name.split(".").pop()?.toLowerCase();
	return TEXT_EXTENSIONS.has(ext);
}

export function handleFileSelect(
	e: Event,
	setAttachments: (fn: (prev: File[]) => File[]) => void,
	fileInputRef: { current: HTMLInputElement | null },
): void {
	const files = (e.target as HTMLInputElement).files;
	if (!files) return;
	const allFiles = Array.from(files);
	const textFiles = allFiles.filter(isTextFile);
	const rejected = allFiles.length - textFiles.length;
	if (rejected > 0) {
		showToast(
			`${rejected} file(s) skipped — only text files are supported in chat`,
			"error",
		);
	}
	const newFiles = textFiles.slice(0, 5);
	setAttachments((prev) => [...prev, ...newFiles].slice(0, 5));
	if (fileInputRef.current) fileInputRef.current.value = "";
}

export function removeAttachment(
	idx: number,
	setAttachments: (fn: (prev: File[]) => File[]) => void,
): void {
	setAttachments((prev) => prev.filter((_, i) => i !== idx));
}
