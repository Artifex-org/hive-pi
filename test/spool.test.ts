/**
 * The spool is the only copy of a session's numbers when the network is down,
 * which is exactly when it is least likely to be exercised by hand. One file per
 * run, rewritten in place — cumulative payloads mean the newest supersedes, and
 * that is what bounds it.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsagePayload } from "../extensions/hive-telemetry/types.ts";

let dir: string;

// Only spoolDir is redirected; everything else in identity.ts stays real.
vi.mock("../extensions/hive-telemetry/identity.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../extensions/hive-telemetry/identity.ts")>()),
	spoolDir: () => dir,
}));

const { clearSpool, pruneSpool, spoolStats, writeSpool } = await import("../extensions/hive-telemetry/spool.ts");

function payload(runId: string): AgentUsagePayload {
	return {
		client_run_id: runId,
		client_session_id: "sess-1",
		parent_session_id: "",
		seq: 1,
		agent: "pi",
		agent_version: "0.83.0",
		source: "workstation",
		interactive: true,
		compactions: 0,
		compaction_overflows: 0,
		repo: "Artifex-org/hive",
		status: "active",
		outcome: "",
		started_at: new Date(1_770_000_000_000).toISOString(),
		duration_ms: 1000,
		turns: 1,
		tool_calls: 0,
		tool_errors: 0,
		models: [],
		tools: [],
		gates: [],
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hive-pi-spool-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("writeSpool", () => {
	it("writes one file per run and round-trips the payload", () => {
		writeSpool(payload("run-1"));

		expect(readdirSync(dir)).toEqual(["run-1.json"]);
		expect(JSON.parse(readFileSync(join(dir, "run-1.json"), "utf8")).client_run_id).toBe("run-1");
	});

	it("rewrites in place, so a long session never accumulates files", () => {
		writeSpool(payload("run-1"));
		writeSpool({ ...payload("run-1"), seq: 2 });
		writeSpool({ ...payload("run-1"), seq: 3 });

		expect(readdirSync(dir)).toEqual(["run-1.json"]);
		expect(JSON.parse(readFileSync(join(dir, "run-1.json"), "utf8")).seq).toBe(3);
	});

	it("creates the directory 0700 and the file 0600", () => {
		writeSpool(payload("run-1"));

		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "run-1.json")).mode & 0o777).toBe(0o600);
	});

	it("leaves no .tmp behind — the rename is atomic", () => {
		writeSpool(payload("run-1"));
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
});

describe("clearSpool", () => {
	it("removes the named run and only that run", () => {
		writeSpool(payload("run-1"));
		writeSpool(payload("run-2"));

		clearSpool("run-1");

		expect(readdirSync(dir)).toEqual(["run-2.json"]);
	});

	it("is a no-op for a run that was never spooled", () => {
		expect(() => clearSpool("never-existed")).not.toThrow();
	});
});

describe("pruneSpool", () => {
	it("drops entries past the 14-day TTL and keeps fresh ones", () => {
		writeSpool(payload("fresh"));
		writeSpool(payload("stale"));
		const old = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(join(dir, "stale.json"), old, old);

		pruneSpool();

		expect(existsSync(join(dir, "fresh.json"))).toBe(true);
		expect(existsSync(join(dir, "stale.json"))).toBe(false);
	});

	it("enforces the file-count cap, keeping the newest", () => {
		for (let i = 0; i < 520; i++) {
			const p = join(dir, `run-${String(i).padStart(4, "0")}.json`);
			writeFileSync(p, JSON.stringify(payload(`run-${i}`)), { mode: 0o600 });
			const t = (Date.now() - (520 - i) * 1000) / 1000;
			utimesSync(p, t, t);
		}

		pruneSpool();

		const left = readdirSync(dir);
		expect(left).toHaveLength(500);
		expect(left).toContain("run-0519.json");
		expect(left).not.toContain("run-0000.json");
	});
});

describe("spoolStats", () => {
	it("reports zero for an absent directory rather than throwing", () => {
		rmSync(dir, { recursive: true, force: true });
		expect(spoolStats()).toEqual({ files: 0, bytes: 0 });
	});

	it("counts what is on disk", () => {
		writeSpool(payload("run-1"));
		writeSpool(payload("run-2"));

		const stats = spoolStats();
		expect(stats.files).toBe(2);
		expect(stats.bytes).toBeGreaterThan(0);
	});
});
