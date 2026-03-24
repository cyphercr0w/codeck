import { Router } from "express";
import {
	readdir,
	stat,
	readFile,
	writeFile,
	mkdir,
	unlink,
	rmdir,
	rm,
	rename,
	realpath,
} from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, sep } from "path";
import { broadcastStatus } from "../web/websocket.js";

// Resolve WORKSPACE to absolute path at startup for consistent path traversal checks
const WORKSPACE = resolve(process.env.WORKSPACE || "/workspace");

// Image uploads directory
const UPLOADS_DIR = join(WORKSPACE, ".codeck", "uploads");

// Upload rate limiting: per-IP, sliding window
const UPLOAD_WINDOW_MS = 60_000; // 1 minute
const UPLOAD_MAX_PER_WINDOW = 10;
const UPLOAD_MAX_BYTES_PER_HOUR = 100 * 1024 * 1024; // 100 MB
const uploadTracker = new Map<
	string,
	{ timestamps: number[]; bytesThisHour: number; hourStart: number }
>();

// Periodic cleanup: remove stale entries every 10 minutes
setInterval(() => {
	const now = Date.now();
	for (const [ip, tracker] of uploadTracker) {
		if (now - tracker.hourStart > 3_600_000) uploadTracker.delete(ip);
	}
}, 600_000).unref();

function checkUploadRateLimit(
	ip: string,
	incomingBytes: number,
): string | null {
	const now = Date.now();
	let tracker = uploadTracker.get(ip);
	if (!tracker) {
		tracker = { timestamps: [], bytesThisHour: 0, hourStart: now };
		uploadTracker.set(ip, tracker);
	}

	// Reset hourly byte counter
	if (now - tracker.hourStart > 3_600_000) {
		tracker = { timestamps: [], bytesThisHour: 0, hourStart: now };
		uploadTracker.set(ip, tracker);
	}

	// Remove timestamps outside window
	const recentTimestamps = tracker.timestamps.filter(
		(t) => now - t < UPLOAD_WINDOW_MS,
	);

	if (recentTimestamps.length >= UPLOAD_MAX_PER_WINDOW) {
		return `Rate limit exceeded: max ${UPLOAD_MAX_PER_WINDOW} uploads per minute`;
	}

	if (tracker.bytesThisHour + incomingBytes > UPLOAD_MAX_BYTES_PER_HOUR) {
		return "Rate limit exceeded: max 100 MB uploads per hour";
	}

	// Record this upload
	uploadTracker.set(ip, {
		timestamps: [...recentTimestamps, now],
		bytesThisHour: tracker.bytesThisHour + incomingBytes,
		hourStart: tracker.hourStart,
	});
	return null;
}

// Allowed image MIME types → file extension mapping
const IMAGE_TYPES: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const router = Router();

/**
 * Resolve a relative path against a base directory and validate it stays within bounds.
 * Returns the validated path, or null if access is denied.
 *
 * Path traversal is prevented by resolving ".." segments and checking the result
 * starts with the base directory. Symlinks within the workspace are intentionally
 * followed — they are placed by the admin (e.g., repo symlinks for self-dev).
 */
async function safePath(
	base: string,
	relativePath: string,
): Promise<string | null> {
	const resolved = resolve(base, relativePath);
	if (!resolved.startsWith(base + sep) && resolved !== base) return null;
	// Resolve symlinks to prevent symlink-based path traversal (e.g., symlink → /etc/passwd)
	try {
		const real = await realpath(resolved);
		if (!real.startsWith(base + sep) && real !== base) return null;
	} catch {
		// Path doesn't exist yet (e.g., new file write) — resolve-based check is sufficient
	}
	return resolved;
}

// List directory files
router.get("/", async (req, res) => {
	const relativePath = (req.query.path || "") as string;
	const typeFilter = req.query.type as string | undefined;
	const fullPath = await safePath(WORKSPACE, relativePath);

	if (!fullPath) {
		res.status(403).json({ error: "Access denied" });
		return;
	}

	try {
		const entries = await readdir(fullPath, { withFileTypes: true });
		const filtered = entries.filter((e) => !e.name.startsWith("."));

		let items;
		if (typeFilter === "dir") {
			// Fast path: only directories, no stat() calls needed
			items = filtered
				.filter((e) => e.isDirectory())
				.map((e) => ({ name: e.name, isDirectory: true as const }));
		} else {
			// Full listing with stat for size/modified
			items = await Promise.all(
				filtered.map(async (e) => {
					if (e.isDirectory()) {
						return { name: e.name, isDirectory: true as const, size: 0 };
					}
					const itemPath = join(fullPath, e.name);
					try {
						const s = await stat(itemPath);
						return {
							name: e.name,
							isDirectory: false as const,
							size: s.size,
							modified: s.mtime,
						};
					} catch {
						return { name: e.name, isDirectory: false as const, size: 0 };
					}
				}),
			);
		}

		items.sort((a, b) => {
			if (a.isDirectory && !b.isDirectory) return -1;
			if (!a.isDirectory && b.isDirectory) return 1;
			return a.name.localeCompare(b.name);
		});

		res.json({ success: true, path: relativePath, items });
	} catch {
		res.status(404).json({ error: "Directory not found" });
	}
});

// Read file content (text only, limited to 100KB)
router.get("/read", async (req, res) => {
	const relativePath = req.query.path as string;
	if (!relativePath) {
		res.status(400).json({ error: "Path required" });
		return;
	}

	const fullPath = await safePath(WORKSPACE, relativePath);

	if (!fullPath) {
		res.status(403).json({ error: "Access denied" });
		return;
	}

	try {
		const s = await stat(fullPath);

		if (s.size > 100 * 1024) {
			res.json({ success: false, error: "File too large", size: s.size });
			return;
		}

		const content = await readFile(fullPath, "utf-8");
		res.json({ success: true, content, size: s.size });
	} catch {
		res.status(404).json({ error: "File not found" });
	}
});

// Write file content (text only, limited to 500KB)
router.put("/write", async (req, res) => {
	const { path: relativePath, content } = req.body;
	if (!relativePath || typeof relativePath !== "string") {
		res.status(400).json({ error: "Path required" });
		return;
	}
	if (typeof content !== "string") {
		res.status(400).json({ error: "Content required" });
		return;
	}
	if (content.length > 500 * 1024) {
		res.status(400).json({ error: "Content too large (max 500KB)" });
		return;
	}

	const fullPath = await safePath(WORKSPACE, relativePath);

	if (!fullPath) {
		res.status(403).json({ error: "Access denied" });
		return;
	}

	try {
		// Write directly — handle ENOENT to report missing parent directory
		await writeFile(fullPath, content, "utf-8");
		res.json({ success: true });
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			res.status(404).json({ error: "Parent directory does not exist" });
		} else {
			res.status(500).json({ error: "Error writing file" });
		}
	}
});

// Create directory
router.post("/mkdir", async (req, res) => {
	const { name } = req.body;
	if (!name || typeof name !== "string") {
		res.status(400).json({ error: "name required" });
		return;
	}

	// Sanitize: strip special characters (keep word chars, dash, dot, slash, space)
	const sanitized = name.trim().replace(/[^\w\-\.\/\s]/g, "");

	// Strip leading dots from the final path segment to prevent hidden directories
	const segments = sanitized.split("/");
	const lastIdx = segments.length - 1;
	segments[lastIdx] = segments[lastIdx].replace(/^\.+/, "");
	const cleanName = segments.join("/").trim();

	if (!cleanName || cleanName.length > 200) {
		res.status(400).json({ error: "Invalid name" });
		return;
	}

	const fullPath = await safePath(WORKSPACE, cleanName);

	if (!fullPath) {
		res.status(403).json({ error: "Access denied" });
		return;
	}

	try {
		await mkdir(fullPath, { recursive: false });
		broadcastStatus();
		res.json({ success: true, name: cleanName });
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			res.status(409).json({ error: "Already exists" });
		} else if (code === "ENOENT") {
			res.status(404).json({ error: "Parent directory does not exist" });
		} else {
			res.status(500).json({ error: "Error creating directory" });
		}
	}
});

// Delete file or directory
router.delete("/delete", async (req, res) => {
	const { path: relativePath, force } = req.body;
	if (!relativePath || typeof relativePath !== "string") {
		res.status(400).json({ error: "Path required" });
		return;
	}

	const fullPath = await safePath(WORKSPACE, relativePath);

	if (!fullPath) {
		res.status(403).json({ error: "Access denied" });
		return;
	}

	// Prevent deleting the workspace root itself
	if (fullPath === WORKSPACE) {
		res.status(403).json({ error: "Cannot delete workspace root" });
		return;
	}

	try {
		const s = await stat(fullPath);
		if (s.isDirectory()) {
			if (force) {
				await rm(fullPath, { recursive: true, force: true });
			} else {
				await rmdir(fullPath);
			}
		} else {
			await unlink(fullPath);
		}
		broadcastStatus();
		res.json({ success: true });
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			res.status(404).json({ error: "File not found" });
		} else if (code === "ENOTEMPTY") {
			res.status(409).json({ error: "Directory not empty" });
		} else {
			res.status(500).json({ error: "Error deleting file" });
		}
	}
});

// Rename/move file or directory
router.post("/rename", async (req, res) => {
	const { oldPath, newPath } = req.body;
	if (!oldPath || typeof oldPath !== "string") {
		res.status(400).json({ error: "oldPath required" });
		return;
	}
	if (!newPath || typeof newPath !== "string") {
		res.status(400).json({ error: "newPath required" });
		return;
	}

	const fullOldPath = await safePath(WORKSPACE, oldPath);
	const fullNewPath = await safePath(WORKSPACE, newPath);

	if (!fullOldPath || !fullNewPath) {
		res.status(403).json({ error: "Access denied" });
		return;
	}

	// Prevent renaming the workspace root
	if (fullOldPath === WORKSPACE) {
		res.status(403).json({ error: "Cannot rename workspace root" });
		return;
	}

	try {
		await rename(fullOldPath, fullNewPath);
		broadcastStatus();
		res.json({ success: true });
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			res.status(404).json({ error: "Source not found" });
		} else {
			res.status(500).json({ error: "Error renaming file" });
		}
	}
});

// Upload image — accepts base64-encoded image data, saves to .codeck/uploads/,
// returns the absolute path for injection into Claude Code's stdin.
router.post("/upload-image", async (req, res) => {
	const { data, mimeType, fileName } = req.body;

	if (!data || typeof data !== "string") {
		res.status(400).json({ error: "Base64 image data required" });
		return;
	}

	const ext = IMAGE_TYPES[mimeType];
	if (!ext) {
		res.status(400).json({
			error: `Unsupported image type: ${mimeType}. Supported: ${Object.keys(IMAGE_TYPES).join(", ")}`,
		});
		return;
	}

	// Decode and validate size
	const buffer = Buffer.from(data, "base64");
	if (buffer.length > MAX_IMAGE_SIZE) {
		res.status(400).json({
			error: `Image too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max: 10 MB`,
		});
		return;
	}

	// Rate limit check
	const clientIp = req.ip || req.socket.remoteAddress || "unknown";
	const rateLimitError = checkUploadRateLimit(clientIp, buffer.length);
	if (rateLimitError) {
		res.status(429).json({ error: rateLimitError });
		return;
	}

	if (buffer.length === 0) {
		res.status(400).json({ error: "Empty image data" });
		return;
	}

	try {
		// Ensure uploads directory exists
		if (!existsSync(UPLOADS_DIR)) {
			await mkdir(UPLOADS_DIR, { recursive: true });
		}

		// Generate unique filename: timestamp + optional original name
		const timestamp = Date.now();
		const safeName = fileName
			? fileName.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 50)
			: "image";
		const fullName = `${timestamp}-${safeName}${ext}`;
		const filePath = join(UPLOADS_DIR, fullName);

		await writeFile(filePath, buffer);

		res.json({ success: true, filePath });
	} catch (e) {
		console.error("[Files] Image upload failed:", (e as Error).message);
		res.status(500).json({ error: "Failed to save image" });
	}
});

// Generalized upload — images, videos, text, documents, any file
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB universal limit
const UPLOAD_TYPES: Record<
	string,
	{ maxBytes: number; extensions: Record<string, string> }
> = {
	image: {
		maxBytes: MAX_UPLOAD_BYTES,
		extensions: {
			"image/png": ".png",
			"image/jpeg": ".jpg",
			"image/gif": ".gif",
			"image/webp": ".webp",
			"image/svg+xml": ".svg",
			"image/bmp": ".bmp",
		},
	},
	video: {
		maxBytes: MAX_UPLOAD_BYTES,
		extensions: {
			"video/mp4": ".mp4",
			"video/webm": ".webm",
			"video/quicktime": ".mov",
		},
	},
	text: {
		maxBytes: MAX_UPLOAD_BYTES,
		extensions: {
			"text/plain": ".txt",
			"text/csv": ".csv",
			"text/markdown": ".md",
			"text/html": ".html",
			"text/css": ".css",
			"text/javascript": ".js",
			"application/json": ".json",
			"application/xml": ".xml",
			"text/xml": ".xml",
		},
	},
	document: {
		maxBytes: MAX_UPLOAD_BYTES,
		extensions: {
			"application/pdf": ".pdf",
			"application/msword": ".doc",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
				".docx",
			"application/vnd.ms-excel": ".xls",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
				".xlsx",
		},
	},
	file: {
		maxBytes: MAX_UPLOAD_BYTES,
		extensions: {}, // accept any
	},
};

router.post("/upload", async (req, res) => {
	const { data, mimeType, fileName, type } = req.body;

	if (!data || typeof data !== "string") {
		res.status(400).json({ error: "Data required" });
		return;
	}

	// Auto-detect upload type from MIME if caller didn't specify
	const DOCUMENT_MIMES = new Set(Object.keys(UPLOAD_TYPES.document.extensions));
	const TEXT_MIMES = new Set(Object.keys(UPLOAD_TYPES.text.extensions));
	let uploadType = type;
	if (!uploadType && mimeType) {
		if (mimeType.startsWith("image/")) uploadType = "image";
		else if (mimeType.startsWith("video/")) uploadType = "video";
		else if (DOCUMENT_MIMES.has(mimeType)) uploadType = "document";
		else if (TEXT_MIMES.has(mimeType) || mimeType.startsWith("text/"))
			uploadType = "text";
		else uploadType = "file";
	}
	if (!uploadType) uploadType = "file";
	const typeConfig = UPLOAD_TYPES[uploadType];
	if (!typeConfig) {
		res.status(400).json({ error: `Unsupported type: ${uploadType}` });
		return;
	}

	// For text type, data is raw text; for others, it's base64
	let buffer: Buffer;
	if (uploadType === "text") {
		buffer = Buffer.from(data, "utf-8");
	} else {
		buffer = Buffer.from(data, "base64");
	}

	if (buffer.length > typeConfig.maxBytes) {
		const maxMB = (typeConfig.maxBytes / (1024 * 1024)).toFixed(0);
		res
			.status(400)
			.json({ error: `File too large (max ${maxMB} MB for ${uploadType})` });
		return;
	}

	if (buffer.length === 0) {
		res.status(400).json({ error: "Empty data" });
		return;
	}

	// Rate limit (reuse existing tracker)
	const clientIp = req.ip || req.socket.remoteAddress || "unknown";
	const rateLimitError = checkUploadRateLimit(clientIp, buffer.length);
	if (rateLimitError) {
		res.status(429).json({ error: rateLimitError });
		return;
	}

	// Determine extension
	let ext = typeConfig.extensions[mimeType || ""] || "";
	if (!ext && uploadType === "text") ext = ".txt";
	if (!ext) {
		// Try to get extension from fileName for any type
		const parts = fileName ? fileName.split(".") : [];
		const fnExt = parts.length > 1 ? "." + parts.pop() : "";
		ext = fnExt || ".bin";
	}

	try {
		if (!existsSync(UPLOADS_DIR)) {
			await mkdir(UPLOADS_DIR, { recursive: true });
		}

		const timestamp = Date.now();
		const safeName = fileName
			? fileName.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 50)
			: uploadType;
		// Don't double the extension if safeName already ends with it
		const extNorm = ext.startsWith(".") ? ext : `.${ext}`;
		const needsExt =
			ext && !safeName.toLowerCase().endsWith(extNorm.toLowerCase());
		const fullName = `${timestamp}-${safeName}${needsExt ? extNorm : ""}`;
		const filePath = join(UPLOADS_DIR, fullName);

		await writeFile(filePath, buffer);

		res.json({
			success: true,
			filePath,
			type: uploadType,
			size: buffer.length,
		});
	} catch (e) {
		console.error("[Files] Upload failed:", (e as Error).message);
		res.status(500).json({ error: "Failed to save file" });
	}
});

export default router;
