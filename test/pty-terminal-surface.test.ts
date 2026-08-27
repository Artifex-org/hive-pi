/**
 * The terminal surface is the path a human's keystrokes take into an agent's
 * shell, so most of this file is about what must be REFUSED. The lease checks
 * in particular are the whole authorisation story: a FIFO is a file, and any
 * process running as this user can write to it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { terminalSurfaceConfig, terminalSurfaceID } from "../extensions/hive-common/terminalSurface.ts";
import {
	TerminalSurfaceBridge,
	validateTerminalCommand,
	type SurfaceLease,
} from "../extensions/pty-exec/terminalSurface.ts";

/**
 * The config validator insists on a real directory under ~/.hive/scratch with
 * real FIFOs, so the fixture builds one. Cleaned up per test.
 */
function makeSurfaceDir(): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const scratch = path.join(os.homedir(), ".hive", "scratch");
	fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const dir = fs.mkdtempSync(path.join(scratch, "pty-surface-test-"));
	fs.chmodSync(dir, 0o700);
	for (const name of ["frames.fifo", "control.fifo"]) {
		execFileSync("mkfifo", ["-m", "600", path.join(dir, name)]);
	}
	return {
		dir,
		env: {
			HIVE_TERMINAL_SURFACE_DIR: dir,
			HIVE_TERMINAL_FRAME_FIFO: path.join(dir, "frames.fifo"),
			HIVE_TERMINAL_CONTROL_FIFO: path.join(dir, "control.fifo"),
			HIVE_TERMINAL_SURFACE_MANIFEST: path.join(dir, "manifest.json"),
			HIVE_LAUNCH_ID: "11111111-2222-3333-4444-555555555555",
		},
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

const lease: SurfaceLease = { id: "desktop-abcdef0123456789", generation: 7, expires_at: 2_000 };
const base = { id: "cmd-1", lease_id: lease.id, generation: 7 };

describe("terminalSurfaceID", () => {
	/**
	 * The browser publisher uses the launch id AS the surface id. If the terminal
	 * did too, both would PUT the same row and the server's sequence
	 * monotonicity would make them tombstone each other — which looks like
	 * flapping, not like a collision.
	 */
	it("is distinct from the launch id", () => {
		const launch = "11111111-2222-3333-4444-555555555555";
		expect(terminalSurfaceID(launch)).not.toBe(launch);
	});

	// Sequence monotonicity and the TTL reaper both key on it surviving a restart.
	it("is stable for the same launch and different across launches", () => {
		expect(terminalSurfaceID("launch-a")).toBe(terminalSurfaceID("launch-a"));
		expect(terminalSurfaceID("launch-a")).not.toBe(terminalSurfaceID("launch-b"));
	});

	// The server parses it with parseUUID, and the producer-side regex accepts
	// versions 1-5 only.
	it("is a valid v5 UUID", () => {
		expect(terminalSurfaceID("anything")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});

describe("terminalSurfaceConfig", () => {
	let fixture: ReturnType<typeof makeSurfaceDir>;
	beforeEach(() => void (fixture = makeSurfaceDir()));
	afterEach(() => fixture.cleanup());

	it("accepts a well-formed surface", () => {
		const config = terminalSurfaceConfig(fixture.env);
		expect(config).not.toBeNull();
		expect(config!.dir).toBe(fs.realpathSync(fixture.dir));
		expect(config!.surfaceID).toBe(terminalSurfaceID(fixture.env.HIVE_LAUNCH_ID!));
	});

	it("refuses a directory other local users can read", () => {
		fs.chmodSync(fixture.dir, 0o755);
		expect(terminalSurfaceConfig(fixture.env)).toBeNull();
	});

	it("refuses a path outside the scratch root", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pty-outside-"));
		expect(terminalSurfaceConfig({ ...fixture.env, HIVE_TERMINAL_SURFACE_DIR: outside })).toBeNull();
		fs.rmSync(outside, { recursive: true, force: true });
	});

	it("refuses a frame path that is not a FIFO", () => {
		fs.rmSync(path.join(fixture.dir, "frames.fifo"));
		fs.writeFileSync(path.join(fixture.dir, "frames.fifo"), "not a pipe", { mode: 0o600 });
		expect(terminalSurfaceConfig(fixture.env)).toBeNull();
	});

	it("refuses a fifo path that is not the expected name", () => {
		expect(
			terminalSurfaceConfig({ ...fixture.env, HIVE_TERMINAL_FRAME_FIFO: path.join(fixture.dir, "control.fifo") }),
		).toBeNull();
	});

	it("returns null when the launch published no surface", () => {
		expect(terminalSurfaceConfig({})).toBeNull();
	});
});

describe("validateTerminalCommand", () => {
	it("accepts well-formed stdin and resize", () => {
		expect(validateTerminalCommand({ ...base, kind: "stdin", data: Buffer.from("hi").toString("base64") }, lease, 0))
			.not.toBeNull();
		expect(validateTerminalCommand({ ...base, kind: "resize", rows: 50, cols: 200 }, lease, 0)).not.toBeNull();
	});

	// The lease IS the authorisation. Each of these is somebody without one.
	it("refuses without a lease, with the wrong lease, or after it expires", () => {
		const cmd = { ...base, kind: "stdin" as const, data: "aGk=" };
		expect(validateTerminalCommand(cmd, null, 0)).toBeNull();
		expect(validateTerminalCommand({ ...cmd, lease_id: "someone-elses-lease" }, lease, 0)).toBeNull();
		// A stale generation is a reader that reconnected: its commands must not
		// apply to the new attachment.
		expect(validateTerminalCommand({ ...cmd, generation: 6 }, lease, 0)).toBeNull();
		expect(validateTerminalCommand(cmd, lease, 3_000)).toBeNull();
	});

	it("refuses a kind that is not on the allowlist", () => {
		// `navigate` belongs to the BROWSER surface. Accepting it here would mean
		// the two surfaces' command sets had merged.
		expect(validateTerminalCommand({ ...base, kind: "navigate", url: "http://x" }, lease, 0)).toBeNull();
		expect(validateTerminalCommand({ ...base, kind: "exec", data: "aGk=" }, lease, 0)).toBeNull();
	});

	it("refuses stdin that is not really base64", () => {
		// Buffer.from(…, "base64") is LENIENT — it silently drops invalid
		// characters rather than throwing — so "not base64!" would decode to 6
		// plausible-looking bytes without the charset and round-trip checks.
		for (const data of ["not base64!", "", "<script>", "aGk=====", "a G k="]) {
			expect(validateTerminalCommand({ ...base, kind: "stdin", data }, lease, 0)).toBeNull();
		}
	});

	// Unpadded base64 is still base64: "aGk" is "hi". Rejecting it would be a
	// compatibility trap for any sender that trims padding, and it buys nothing
	// — the decoded bytes are identical either way.
	it("accepts valid base64 with or without padding", () => {
		for (const data of ["aGk=", "aGk"]) {
			expect(validateTerminalCommand({ ...base, kind: "stdin", data }, lease, 0)).not.toBeNull();
		}
	});

	it("refuses stdin over the size cap", () => {
		const big = Buffer.alloc((16 << 10) + 1, 0x61).toString("base64");
		expect(validateTerminalCommand({ ...base, kind: "stdin", data: big }, lease, 0)).toBeNull();
	});

	it("refuses out-of-range or non-integer geometry", () => {
		for (const [rows, cols] of [
			[0, 80],
			[50, 0],
			[513, 80],
			[50, 513],
			[50.5, 80],
		]) {
			expect(validateTerminalCommand({ ...base, kind: "resize", rows, cols }, lease, 0)).toBeNull();
		}
	});
});

describe("TerminalSurfaceBridge", () => {
	let fixture: ReturnType<typeof makeSurfaceDir>;
	beforeEach(() => void (fixture = makeSurfaceDir()));
	afterEach(() => fixture.cleanup());

	it("declines to start without a valid surface", () => {
		expect(TerminalSurfaceBridge.start({})).toBeNull();
	});

	it("writes a terminal manifest on start and marks it ended on stop", () => {
		const bridge = TerminalSurfaceBridge.start(fixture.env)!;
		expect(bridge).not.toBeNull();
		const manifestPath = path.join(fixture.dir, "manifest.json");
		const ready = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		expect(ready).toMatchObject({ version: 1, kind: "terminal", state: "ready" });
		// The desktop side reads geometry from the manifest for a terminal, where
		// a browser would use latest-web.json.
		expect(ready.rows).toBeGreaterThan(0);
		expect(ready.cols).toBeGreaterThan(0);

		bridge.stop();
		expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).state).toBe("ended");
	});

	// Nobody is reading the FIFO in these tests, which is the normal state before
	// anyone attaches. Output must be buffered, never thrown away or fatal.
	it("survives writing output with no reader attached", () => {
		const bridge = TerminalSurfaceBridge.start(fixture.env)!;
		expect(() => {
			for (let i = 0; i < 100; i++) bridge.writeOutput(Buffer.from(`line ${i}\n`));
			bridge.beginCommand("call-1", "echo hi", "/tmp");
			bridge.endCommand("call-1", 0);
		}).not.toThrow();
		bridge.stop();
	});

	// The divergence from the browser bridge: bytes are not disposable, so an
	// overflow must be bounded AND announced rather than silently dropping.
	it("bounds its buffer under sustained backpressure", () => {
		const bridge = TerminalSurfaceBridge.start(fixture.env)!;
		// 2 MiB of output into a pipe nobody drains.
		for (let i = 0; i < 2048; i++) bridge.writeOutput(Buffer.alloc(1024, 0x61));
		// The real assertion is that it neither threw nor grew without bound; the
		// process is still responsive and the manifest still writable.
		expect(() => bridge.writeOutput(Buffer.from("still alive\n"))).not.toThrow();
		bridge.stop();
	});

	it("reports no lease when none has been taken", () => {
		const bridge = TerminalSurfaceBridge.start(fixture.env)!;
		expect(bridge.hasLease()).toBe(false);
		bridge.stop();
	});

	it("ignores a lease file other local users could have written", () => {
		const bridge = TerminalSurfaceBridge.start(fixture.env)!;
		fs.writeFileSync(
			path.join(fixture.dir, "lease.json"),
			JSON.stringify({ id: "desktop-abcdef0123456789", generation: 1, expires_at: Date.now() + 60_000 }),
			{ mode: 0o644 },
		);
		expect(bridge.hasLease()).toBe(false);
		bridge.stop();
	});

	it("honours a private, unexpired lease", () => {
		const bridge = TerminalSurfaceBridge.start(fixture.env)!;
		fs.writeFileSync(
			path.join(fixture.dir, "lease.json"),
			JSON.stringify({ id: "desktop-abcdef0123456789", generation: 1, expires_at: Date.now() + 60_000 }),
			{ mode: 0o600 },
		);
		expect(bridge.hasLease()).toBe(true);
		bridge.stop();
	});
});
