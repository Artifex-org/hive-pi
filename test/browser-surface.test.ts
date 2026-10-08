import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkSurfaceCommand,
	FrameSink,
	leasePausesAgent,
	nextSurfaceSequence,
	surfaceConfig,
	validateSurfaceCommand,
} from "../extensions/browser/surface.ts";

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
		// The relay FIFO is derived, and an older node that made none is still accepted.
		expect(config?.relayFrameFIFO).toBe(path.join(config!.dir, "relay-frames.fifo"));
		expect(nextSurfaceSequence(config!)).toBe(0);
		writeFileSync(config!.latestWebMetadata, JSON.stringify({ sequence: 41 }), { mode: 0o600 });
		expect(nextSurfaceSequence(config!)).toBe(42);
		expect(surfaceConfig({ ...env, HIVE_BROWSER_FRAME_FIFO: path.join(config!.dir, "other") })).toBeNull();
		expect(surfaceConfig({ ...env, HIVE_BROWSER_SURFACE_DIR: "/tmp/browser-surface" })).toBeNull();
	});
});

describe("browser surface control lease", () => {
	const lease = { id: "lease-0123456789abcdef", generation: 4, expires_at: 20_000, exclusive: false };

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

describe("browser surface commands (protocol v1 §4)", () => {
	const lease = { id: "relay-0123456789abcdef", generation: 7, expires_at: 20_000, exclusive: false };
	const stamp = { lease_id: lease.id, generation: 7 };
	const check = (command: Record<string, unknown>) => checkSurfaceCommand({ id: "c1", ...stamp, ...command }, lease, 10_000);

	it("passes wheel deltas through, bounded to ±10000", () => {
		const wheel = { kind: "mouse", event_type: "mouseWheel", x: 10, y: 20, delta_x: -40, delta_y: 120 };
		expect(check(wheel)).toEqual({
			ok: true,
			command: expect.objectContaining({ kind: "mouse", event_type: "mouseWheel", delta_x: -40, delta_y: 120 }),
		});
		expect(check({ ...wheel, delta_y: 10_000 }).ok).toBe(true);
		expect(check({ ...wheel, delta_y: 10_001 })).toEqual({ ok: false, id: "c1", error: "invalid" });
		expect(check({ ...wheel, delta_x: Number.NaN }).ok).toBe(false);
		expect(check({ ...wheel, delta_x: "1" }).ok).toBe(false);
	});

	it("accepts the desktop app's shape, which sends every unset field as null", () => {
		const checked = check({
			kind: "key", url: null, event_type: "keyDown", x: null, y: null, button: null, click_count: null,
			key: "a", code: "KeyA", text: "a", modifiers: null, data: null, rows: null, cols: null,
		});
		expect(checked.ok && checked.command).toEqual({
			id: "c1", ...stamp, kind: "key", event_type: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: undefined,
		});
		expect(check({ kind: "mouse", event_type: "mousePressed", x: 1, y: 2, button: "left", click_count: 1, modifiers: null }).ok).toBe(true);
	});

	it("caps key and pasted text at 2000 characters so a control line stays one atomic write", () => {
		expect(check({ kind: "key", event_type: "char", text: "x".repeat(2_000) }).ok).toBe(true);
		expect(check({ kind: "key", event_type: "char", text: "x".repeat(2_001) }).ok).toBe(false);
		expect(check({ kind: "insert_text", text: "x".repeat(2_000) }).ok).toBe(true);
		expect(check({ kind: "insert_text", text: "x".repeat(2_001) }).ok).toBe(false);
		expect(check({ kind: "insert_text", text: "" }).ok).toBe(false);
		expect(check({ kind: "insert_text" }).ok).toBe(false);
	});

	it("validates history and tab commands", () => {
		for (const action of ["back", "forward", "reload"]) expect(check({ kind: "history", action }).ok).toBe(true);
		expect(check({ kind: "history", action: "home" }).ok).toBe(false);
		expect(check({ kind: "tab", action: "open", url: "http://127.0.0.1:3000/" }).ok).toBe(true);
		expect(check({ kind: "tab", action: "open", url: "file:///etc/passwd" }).ok).toBe(false);
		expect(check({ kind: "tab", action: "open", url: "https://u:p@example.test" }).ok).toBe(false);
		expect(check({ kind: "tab", action: "open" }).ok).toBe(false);
		expect(check({ kind: "tab", action: "close" }).ok).toBe(true);
		expect(check({ kind: "tab", action: "view", view: "operator" }).ok).toBe(true);
		expect(check({ kind: "tab", action: "view", view: "agent" }).ok).toBe(true);
		expect(check({ kind: "tab", action: "view", view: "other" }).ok).toBe(false);
		expect(check({ kind: "tab", action: "split" }).ok).toBe(false);
	});

	it("answers a parsed command that has an id: no_lease without a live lease, invalid otherwise", () => {
		const navigate = { id: "n1", ...stamp, kind: "navigate", url: "https://example.test" };
		expect(checkSurfaceCommand(navigate, null, 10_000)).toEqual({ ok: false, id: "n1", error: "no_lease" });
		expect(checkSurfaceCommand(navigate, lease, 20_000)).toEqual({ ok: false, id: "n1", error: "no_lease" });
		expect(checkSurfaceCommand({ ...navigate, generation: 6 }, lease, 10_000)).toEqual({ ok: false, id: "n1", error: "invalid" });
		expect(checkSurfaceCommand({ ...navigate, lease_id: "desktop-0123456789abcdef" }, lease, 10_000))
			.toEqual({ ok: false, id: "n1", error: "invalid" });
		expect(checkSurfaceCommand({ ...navigate, kind: "evaluate" }, lease, 10_000)).toEqual({ ok: false, id: "n1", error: "invalid" });
		// No usable id: nothing can be answered.
		expect(checkSurfaceCommand({ ...navigate, id: "" }, lease, 10_000)).toEqual({ ok: false, id: null, error: "invalid" });
		expect(checkSurfaceCommand({ ...navigate, id: "x".repeat(129) }, lease, 10_000)).toEqual({ ok: false, id: null, error: "invalid" });
		expect(checkSurfaceCommand("navigate", lease, 10_000)).toEqual({ ok: false, id: null, error: "invalid" });
		expect(validateSurfaceCommand({ ...navigate, generation: 6 }, lease, 10_000)).toBeNull();
	});
});

describe("browser surface lease pausing (protocol v1 §3)", () => {
	const lease = { id: "relay-0123456789abcdef", generation: 7, expires_at: 20_000, exclusive: true };

	it("pauses the agent only for an unexpired exclusive lease while the agent page is in view", () => {
		expect(leasePausesAgent(lease, "agent", 10_000)).toBe(true);
		expect(leasePausesAgent(lease, "operator", 10_000)).toBe(false);
		expect(leasePausesAgent(lease, "agent", 20_000)).toBe(false);
		expect(leasePausesAgent({ ...lease, exclusive: false }, "agent", 10_000)).toBe(false);
		expect(leasePausesAgent(null, "agent", 10_000)).toBe(false);
	});
});

describe("browser surface frame sink", () => {
	function fifo(): string {
		const env = bridgeEnv();
		const file = path.join(env.HIVE_BROWSER_SURFACE_DIR!, "relay-frames.fifo");
		const made = spawnSync("mkfifo", ["-m", "600", file]);
		if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
		return file;
	}

	function line(tag: string, size: number): Buffer {
		return Buffer.from(`${JSON.stringify({ tag, pad: "x".repeat(size) })}\n`);
	}

	it("skips a missing FIFO, a regular file and a FIFO nobody reads", () => {
		const env = bridgeEnv();
		const missing = new FrameSink(path.join(env.HIVE_BROWSER_SURFACE_DIR!, "relay-frames.fifo"));
		missing.push(line("a", 10), "frame");
		missing.push(line("r", 10), "result");
		expect(missing.pending).toBe(false);
		const regular = path.join(env.HIVE_BROWSER_SURFACE_DIR!, "plain");
		writeFileSync(regular, "", { mode: 0o600 });
		const plain = new FrameSink(regular);
		plain.push(line("a", 10), "frame");
		expect(plain.pending).toBe(false);
		expect(fs.readFileSync(regular, "utf8")).toBe("");
		const unread = new FrameSink(fifo());
		unread.push(line("a", 10), "frame");
		expect(unread.pending).toBe(false);
	});

	it("finishes a started line, keeps answers, and keeps only the newest frame behind it", () => {
		const file = fifo();
		const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		try {
			const sink = new FrameSink(file);
			// Each frame is far larger than a pipe's buffer: the first write is partial.
			sink.push(line("frame-a", 600_000), "frame");
			expect(sink.pending).toBe(true);
			sink.push(line("frame-b", 600_000), "frame");
			sink.push(line("result-1", 10), "result");
			sink.push(line("frame-c", 600_000), "frame");
			sink.push(line("result-2", 10), "result");
			let text = "";
			const chunk = Buffer.allocUnsafe(1 << 20);
			for (let guard = 0; guard < 10_000 && (sink.pending || text === ""); guard++) {
				try {
					const n = fs.readSync(reader, chunk, 0, chunk.length, null);
					if (n > 0) text += chunk.subarray(0, n).toString("utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
				}
				sink.flush();
			}
			for (;;) {
				try {
					const n = fs.readSync(reader, chunk, 0, chunk.length, null);
					if (n <= 0) break;
					text += chunk.subarray(0, n).toString("utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EAGAIN") break;
					throw error;
				}
			}
			const tags = text.split("\n").filter(Boolean).map((one) => (JSON.parse(one) as { tag: string }).tag);
			expect(tags).toEqual(["frame-a", "result-1", "result-2", "frame-c"]);
			sink.close();
		} finally {
			fs.closeSync(reader);
		}
	});
});
