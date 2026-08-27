import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { nextSurfaceSequence, surfaceConfig, validateSurfaceCommand } from "../extensions/browser/surface.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bridgeEnv(): NodeJS.ProcessEnv {
	const scratch = path.join(os.homedir(), ".hive", "scratch");
	const relative = path.relative(scratch, process.cwd());
	const first = relative.split(path.sep)[0];
	// A launched test may write only inside its own scratch child, not the
	// shared parent; an ordinary checkout uses the parent directly.
	const writable = first && first !== ".." ? path.join(scratch, first) : scratch;
	mkdirSync(writable, { recursive: true, mode: 0o700 });
	const root = mkdtempSync(path.join(writable, "browser-surface-test-"));
	roots.push(root);
	const dir = path.join(root, "browser-surface");
	mkdirSync(dir, { mode: 0o700 });
	for (const name of ["frames.fifo", "control.fifo"]) {
		const made = spawnSync("mkfifo", ["-m", "600", path.join(dir, name)]);
		if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
	}
	return {
		HIVE_LAUNCH_ID: "launch-surface-test",
		HIVE_BROWSER_SURFACE_DIR: dir,
		HIVE_BROWSER_FRAME_FIFO: path.join(dir, "frames.fifo"),
		HIVE_BROWSER_CONTROL_FIFO: path.join(dir, "control.fifo"),
		HIVE_BROWSER_SURFACE_MANIFEST: path.join(dir, "manifest.json"),
	};
}

describe("browser surface path contract", () => {
	it("accepts only the private launch scratch directory and exact FIFO names", () => {
		const env = bridgeEnv();
		const config = surfaceConfig(env);
		expect(config?.launchID).toBe("launch-surface-test");
		expect(config?.frameFIFO).toBe(env.HIVE_BROWSER_FRAME_FIFO);
		expect(nextSurfaceSequence(config!)).toBe(0);
		writeFileSync(config!.latestWebMetadata, JSON.stringify({ sequence: 41 }), { mode: 0o600 });
		expect(nextSurfaceSequence(config!)).toBe(42);
		expect(surfaceConfig({ ...env, HIVE_BROWSER_FRAME_FIFO: path.join(config!.dir, "other") })).toBeNull();
		expect(surfaceConfig({ ...env, HIVE_BROWSER_SURFACE_DIR: "/tmp/browser-surface" })).toBeNull();
	});
});

describe("browser surface control lease", () => {
	const lease = { id: "lease-0123456789abcdef", generation: 4, expires_at: 20_000 };

	it("accepts allow-listed navigation, mouse and key commands", () => {
		expect(validateSurfaceCommand({
			id: "n1", lease_id: lease.id, generation: 4, kind: "navigate", url: "https://example.test/app",
		}, lease, 10_000)?.kind).toBe("navigate");
		expect(validateSurfaceCommand({
			id: "m1", lease_id: lease.id, generation: 4, kind: "mouse", event_type: "mousePressed", x: 4, y: 8,
		}, lease, 10_000)?.kind).toBe("mouse");
		expect(validateSurfaceCommand({
			id: "k1", lease_id: lease.id, generation: 4, kind: "key", event_type: "keyDown", key: "Enter",
		}, lease, 10_000)?.kind).toBe("key");
	});

	it("rejects expiry, stale generation, URL credentials and arbitrary CDP events", () => {
		const navigate = { id: "n1", lease_id: lease.id, generation: 4, kind: "navigate", url: "https://example.test" };
		expect(validateSurfaceCommand(navigate, lease, 20_000)).toBeNull();
		expect(validateSurfaceCommand({ ...navigate, generation: 3 }, lease, 10_000)).toBeNull();
		expect(validateSurfaceCommand({ ...navigate, url: "https://user:pass@example.test" }, lease, 10_000)).toBeNull();
		expect(validateSurfaceCommand({
			id: "m1", lease_id: lease.id, generation: 4, kind: "mouse", event_type: "Runtime.evaluate", x: 0, y: 0,
		}, lease, 10_000)).toBeNull();
	});
});
