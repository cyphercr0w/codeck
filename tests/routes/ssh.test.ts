/**
 * tests/routes/ssh.test.ts
 *
 * Tests for SSH routes:
 *   GET    /api/ssh/status     — check if SSH key exists
 *   POST   /api/ssh/generate   — generate SSH key pair
 *   GET    /api/ssh/public-key — get public key content
 *   GET    /api/ssh/test       — test SSH connection to GitHub
 *   DELETE /api/ssh/key        — delete SSH key pair
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// Hoist mock functions
const {
	mockHasSSHKey,
	mockGenerateSSHKey,
	mockGetSSHPublicKey,
	mockTestSSHConnection,
	mockDeleteSSHKey,
	mockBroadcastStatus,
} = vi.hoisted(() => ({
	mockHasSSHKey: vi.fn(),
	mockGenerateSSHKey: vi.fn(),
	mockGetSSHPublicKey: vi.fn(),
	mockTestSSHConnection: vi.fn(),
	mockDeleteSSHKey: vi.fn(),
	mockBroadcastStatus: vi.fn(),
}));

// Mock dependencies before importing router
vi.mock("../../apps/runtime/src/services/git.js", () => ({
	hasSSHKey: mockHasSSHKey,
	generateSSHKey: mockGenerateSSHKey,
	getSSHPublicKey: mockGetSSHPublicKey,
	testSSHConnection: mockTestSSHConnection,
	deleteSSHKey: mockDeleteSSHKey,
}));

vi.mock("../../apps/runtime/src/web/websocket.js", () => ({
	broadcastStatus: mockBroadcastStatus,
}));

// Import router after mocks
import sshRouter from "../../apps/runtime/src/routes/ssh.routes.js";

describe("SSH Routes", () => {
	let app: Express;

	beforeEach(() => {
		app = express();
		app.use(express.json());
		app.use("/api/ssh", sshRouter);

		vi.clearAllMocks();

		// Default mock behaviors
		mockHasSSHKey.mockReturnValue(false);
		mockGenerateSSHKey.mockReturnValue({
			success: true,
			publicKey: "ssh-ed25519 AAAA...",
		});
		mockGetSSHPublicKey.mockReturnValue("ssh-ed25519 AAAA... user@host");
		mockTestSSHConnection.mockReturnValue(false);
		mockDeleteSSHKey.mockReturnValue({ success: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// ── GET /status ───────────────────────────────────────────────────

	describe("GET /status", () => {
		it("should return hasKey: true when SSH key exists", async () => {
			mockHasSSHKey.mockReturnValue(true);
			mockGetSSHPublicKey.mockReturnValue("ssh-ed25519 AAAA...");
			mockTestSSHConnection.mockReturnValue(true);

			const response = await request(app).get("/api/ssh/status");

			expect(response.status).toBe(200);
			expect(response.body).toEqual({
				hasKey: true,
				publicKey: "ssh-ed25519 AAAA...",
				authenticated: true,
			});
			expect(mockHasSSHKey).toHaveBeenCalledOnce();
		});

		it("should return hasKey: false when no SSH key", async () => {
			mockHasSSHKey.mockReturnValue(false);

			const response = await request(app).get("/api/ssh/status");

			expect(response.status).toBe(200);
			expect(response.body).toEqual({
				hasKey: false,
				publicKey: null,
				authenticated: false,
			});
		});
	});

	// ── POST /generate ────────────────────────────────────────────────

	describe("POST /generate", () => {
		it("should generate a new SSH key", async () => {
			const result = { success: true, publicKey: "ssh-ed25519 AAAA..." };
			mockGenerateSSHKey.mockReturnValue(result);

			const response = await request(app).post("/api/ssh/generate").send({});

			expect(response.status).toBe(200);
			expect(response.body).toEqual(result);
			expect(mockGenerateSSHKey).toHaveBeenCalledWith(false);
			expect(mockBroadcastStatus).toHaveBeenCalledOnce();
		});

		it("should force regenerate when force=true", async () => {
			const result = { success: true, publicKey: "ssh-ed25519 BBBB..." };
			mockGenerateSSHKey.mockReturnValue(result);

			const response = await request(app)
				.post("/api/ssh/generate")
				.send({ force: true });

			expect(response.status).toBe(200);
			expect(response.body).toEqual(result);
			expect(mockGenerateSSHKey).toHaveBeenCalledWith(true);
		});

		it("should not force regenerate when force is not explicitly true", async () => {
			mockGenerateSSHKey.mockReturnValue({
				success: true,
				publicKey: "ssh-ed25519 CCCC...",
			});

			await request(app).post("/api/ssh/generate").send({ force: "yes" });

			expect(mockGenerateSSHKey).toHaveBeenCalledWith(false);
		});

		it("should handle generate failure", async () => {
			const result = { success: false, error: "Key generation failed" };
			mockGenerateSSHKey.mockReturnValue(result);

			const response = await request(app).post("/api/ssh/generate").send({});

			expect(response.status).toBe(200);
			expect(response.body).toEqual(result);
			expect(mockBroadcastStatus).toHaveBeenCalledOnce();
		});

		it("should broadcast status after generation", async () => {
			mockGenerateSSHKey.mockReturnValue({
				success: true,
				publicKey: "ssh-ed25519...",
			});

			await request(app).post("/api/ssh/generate").send({});

			expect(mockBroadcastStatus).toHaveBeenCalledOnce();
		});
	});

	// ── GET /public-key ───────────────────────────────────────────────

	describe("GET /public-key", () => {
		it("should return public key when it exists", async () => {
			const pubKey = "ssh-ed25519 AAAA... user@codeck";
			mockGetSSHPublicKey.mockReturnValue(pubKey);

			const response = await request(app).get("/api/ssh/public-key");

			expect(response.status).toBe(200);
			expect(response.body).toEqual({ success: true, publicKey: pubKey });
		});

		it("should return 500 when public key is not available", async () => {
			mockGetSSHPublicKey.mockReturnValue(null);

			const response = await request(app).get("/api/ssh/public-key");

			expect(response.status).toBe(500);
			expect(response.body).toEqual({
				success: false,
				error: "Could not get public key",
			});
		});

		it("should return 500 when public key is empty string", async () => {
			mockGetSSHPublicKey.mockReturnValue("");

			const response = await request(app).get("/api/ssh/public-key");

			expect(response.status).toBe(500);
			expect(response.body).toEqual({
				success: false,
				error: "Could not get public key",
			});
		});

		it("should return 500 when public key is undefined", async () => {
			mockGetSSHPublicKey.mockReturnValue(undefined);

			const response = await request(app).get("/api/ssh/public-key");

			expect(response.status).toBe(500);
			expect(response.body).toEqual({
				success: false,
				error: "Could not get public key",
			});
		});
	});

	// ── GET /test ─────────────────────────────────────────────────────

	describe("GET /test", () => {
		it("should return authenticated: true when SSH connection works", async () => {
			mockTestSSHConnection.mockReturnValue(true);

			const response = await request(app).get("/api/ssh/test");

			expect(response.status).toBe(200);
			expect(response.body).toEqual({ success: true, authenticated: true });
			expect(mockTestSSHConnection).toHaveBeenCalledOnce();
		});

		it("should return authenticated: false when SSH connection fails", async () => {
			mockTestSSHConnection.mockReturnValue(false);

			const response = await request(app).get("/api/ssh/test");

			expect(response.status).toBe(200);
			expect(response.body).toEqual({ success: true, authenticated: false });
		});
	});

	// ── DELETE /key ───────────────────────────────────────────────────

	describe("DELETE /key", () => {
		it("should delete SSH key successfully", async () => {
			const result = { success: true };
			mockDeleteSSHKey.mockReturnValue(result);

			const response = await request(app).delete("/api/ssh/key");

			expect(response.status).toBe(200);
			expect(response.body).toEqual(result);
			expect(mockDeleteSSHKey).toHaveBeenCalledOnce();
			expect(mockBroadcastStatus).toHaveBeenCalledOnce();
		});

		it("should return 500 when key deletion fails", async () => {
			const result = { success: false, error: "No key to delete" };
			mockDeleteSSHKey.mockReturnValue(result);

			const response = await request(app).delete("/api/ssh/key");

			expect(response.status).toBe(500);
			expect(response.body).toEqual(result);
			expect(mockBroadcastStatus).toHaveBeenCalledOnce();
		});

		it("should broadcast status after deletion", async () => {
			mockDeleteSSHKey.mockReturnValue({ success: true });

			await request(app).delete("/api/ssh/key");

			expect(mockBroadcastStatus).toHaveBeenCalledOnce();
		});

		it("should broadcast status even on failure", async () => {
			mockDeleteSSHKey.mockReturnValue({ success: false, error: "Failed" });

			await request(app).delete("/api/ssh/key");

			expect(mockBroadcastStatus).toHaveBeenCalledOnce();
		});
	});
});
