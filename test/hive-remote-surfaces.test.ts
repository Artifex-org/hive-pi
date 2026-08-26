import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSurfacePublisher, readWebSnapshot } from "../extensions/hive-remote/surfaces.ts";
import { browserSurfaceConfig } from "../extensions/hive-common/browserSurface.ts";

const roots: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { env: NodeJS.ProcessEnv; updatedAt: number } {
	const scratch = path.join(os.homedir(), ".hive", "scratch");
	const relative = path.relative(scratch, process.cwd());
	const first = relative.split(path.sep)[0];
	const writable = first && first !== ".." ? path.join(scratch, first) : scratch;
	fs.mkdirSync(writable, { recursive: true, mode: 0o700 });
	const root = fs.mkdtempSync(path.join(writable, "remote-surface-test-"));
	roots.push(root);
	const dir = path.join(root, "browser-surface");
	fs.mkdirSync(dir, { mode: 0o700 });
	for (const name of ["frames.fifo", "control.fifo"]) {
		const made = spawnSync("mkfifo", ["-m", "600", path.join(dir, name)]);
		if (made.status !== 0) throw new Error(made.stderr.toString());
	}
	const updatedAt = Date.now();
	const image = Buffer.from("fake-jpeg-bytes");
	fs.writeFileSync(path.join(dir, "latest-web.jpg"), image, { mode: 0o600 });
	fs.writeFileSync(path.join(dir, "latest-web.json"), JSON.stringify({
		version: 1,
		sequence: 7,
		content_type: "image/jpeg",
		size_bytes: image.length,
		url: "https://example.test/app?private=1",
		title: "Agent browser",
		width: 640,
		height: 480,
		updated_at: updatedAt,
	}), { mode: 0o600 });
	return {
		updatedAt,
		env: {
			HIVE_LAUNCH_ID: "123e4567-e89b-42d3-a456-426614174000",
			HIVE_BROWSER_SURFACE_DIR: dir,
			HIVE_BROWSER_FRAME_FIFO: path.join(dir, "frames.fifo"),
			HIVE_BROWSER_CONTROL_FIFO: path.join(dir, "control.fifo"),
			HIVE_BROWSER_SURFACE_MANIFEST: path.join(dir, "manifest.json"),
		},
	};
}

describe("hive-remote browser screenshot publisher", () => {
	it("uploads one latest image, then heartbeats metadata without re-uploading", async () => {
		const { env, updatedAt } = fixture();
		const config = browserSurfaceConfig(env)!;
		expect(readWebSnapshot(config)?.metadata.sequence).toBe(7);
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return new Response(init?.method === "PUT" && typeof init.body === "string" ? "{}" : null, {
				status: init?.method === "PUT" && typeof init.body === "string" ? 200 : 204,
				headers: { "Content-Type": "application/json" },
			});
		}));
		const publisher = new BrowserSurfacePublisher(env);
		const auth = { url: "https://hive.example", token: "secret-not-logged" };
		await publisher.tick(auth, "session-1", updatedAt + 100);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toContain("/surfaces/123e4567-e89b-42d3-a456-426614174000");
		expect(typeof calls[0]?.init?.body).toBe("string");
		expect(calls[1]?.url).toContain("snapshot?sequence=7");
		expect(calls[1]?.init?.body).toBeInstanceOf(Uint8Array);

		await publisher.tick(auth, "session-1", updatedAt + 1_000);
		expect(calls).toHaveLength(3);
		const heartbeat = JSON.parse(String(calls[2]?.init?.body)) as { state: string };
		expect(heartbeat.state).toBe("ready");

		await publisher.tick(auth, "session-1", updatedAt + 20_000);
		expect(calls).toHaveLength(4);
		const stale = JSON.parse(String(calls[3]?.init?.body)) as { state: string };
		expect(stale.state).toBe("stale");
		await publisher.tick(auth, "session-1", updatedAt + 25_000);
		expect(calls).toHaveLength(4);

		const revived = JSON.parse(fs.readFileSync(config.latestWebMetadata, "utf8")) as Record<string, unknown>;
		revived.sequence = 8;
		revived.updated_at = updatedAt + 26_000;
		fs.writeFileSync(config.latestWebMetadata, JSON.stringify(revived), { mode: 0o600 });
		await publisher.tick(auth, "session-1", updatedAt + 26_100);
		expect(calls).toHaveLength(6);
		expect(calls[5]?.url).toContain("snapshot?sequence=8");
	});

	it("stops retrying when the server already tombstoned a stale surface", async () => {
		const { env, updatedAt } = fixture();
		const fetchMock = vi.fn(async () => new Response("{}", {
			status: 409,
			headers: { "Content-Type": "application/json" },
		}));
		vi.stubGlobal("fetch", fetchMock);
		const publisher = new BrowserSurfacePublisher(env);
		const auth = { url: "https://hive.example", token: "secret-not-logged" };
		await publisher.tick(auth, "session-1", updatedAt + 20_000);
		await publisher.tick(auth, "session-1", updatedAt + 25_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
