import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MANIFEST_FILENAME,
	ScreenshotLedger,
	manifestDir,
	manifestPath,
	readManifest,
	reDeriveFromDisk,
} from "../extensions/pr-attachments/manifest.ts";

// A real temp dir per test — the ledger's whole point is that disk, not module
// state, is the source of truth, so exercising it against a file is the honest
// test.
let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-attach-test-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("manifest location", () => {
	it("prefers $HIVE_PR_ATTACHMENTS_DIR when set", () => {
		const env = { HIVE_PR_ATTACHMENTS_DIR: "/var/hive/attach" };
		expect(manifestDir(env, 7)).toBe("/var/hive/attach");
		expect(manifestPath(env, 7)).toBe(`/var/hive/attach/${MANIFEST_FILENAME}`);
	});

	it("falls back to the per-process screenshot dir", () => {
		const env: NodeJS.ProcessEnv = {};
		expect(manifestDir(env, 4131)).toBe(path.join(os.tmpdir(), "pi-browser-4131"));
		expect(manifestPath(env, 4131)).toBe(path.join(os.tmpdir(), "pi-browser-4131", MANIFEST_FILENAME));
	});

	it("treats a blank env var as unset", () => {
		expect(manifestDir({ HIVE_PR_ATTACHMENTS_DIR: "  " }, 9)).toBe(path.join(os.tmpdir(), "pi-browser-9"));
	});
});

describe("ScreenshotLedger.record", () => {
	function ledgerIn(dir: string) {
		return new ScreenshotLedger({ HIVE_PR_ATTACHMENTS_DIR: dir });
	}

	it("records path, label, url and a timestamp, and reads them back", () => {
		const led = ledgerIn(tmp);
		const rec = led.record({ path: "/tmp/pi-browser-1/shot-1.png", label: "before", url: "http://127.0.0.1:3000/" });
		expect(rec).toMatchObject({ path: "/tmp/pi-browser-1/shot-1.png", label: "before", url: "http://127.0.0.1:3000/" });
		expect(rec.taken_at).toMatch(/^\d{4}-\d\d-\d\dT/);
		const all = led.all();
		expect(all).toHaveLength(1);
		expect(all[0]).toEqual(rec);
	});

	it("appends in order and rewrites the whole array", () => {
		const led = ledgerIn(tmp);
		led.record({ path: "/a/shot-1.png", label: "before", url: "u1" });
		led.record({ path: "/a/shot-2.png", label: "after", url: "u2" });
		const all = led.all();
		expect(all.map((r) => r.label)).toEqual(["before", "after"]);
		// The file on disk is valid JSON matching what all() returns.
		const raw = JSON.parse(fs.readFileSync(path.join(tmp, MANIFEST_FILENAME), "utf8"));
		expect(raw).toEqual(all);
	});

	it("keeps an empty-string label when none is given", () => {
		const led = ledgerIn(tmp);
		const rec = led.record({ path: "/a/shot-1.png", label: "", url: "u" });
		expect(rec.label).toBe("");
		expect(led.all()[0].label).toBe("");
	});
});

describe("readManifest", () => {
	it("returns [] for a missing file", () => {
		expect(readManifest(path.join(tmp, "nope.json"))).toEqual([]);
	});

	it("returns [] for malformed JSON", () => {
		const f = path.join(tmp, MANIFEST_FILENAME);
		fs.writeFileSync(f, "{ not json");
		expect(readManifest(f)).toEqual([]);
	});

	it("drops entries missing required fields", () => {
		const f = path.join(tmp, MANIFEST_FILENAME);
		fs.writeFileSync(f, JSON.stringify([{ path: "/a", label: "x", url: "u", taken_at: "t" }, { path: "/b" }, 42]));
		expect(readManifest(f)).toEqual([{ path: "/a", label: "x", url: "u", taken_at: "t" }]);
	});
});

describe("reDeriveFromDisk (compaction fallback)", () => {
	it("reconstructs a labelless ledger from shot-*.png names, oldest first", () => {
		fs.writeFileSync(path.join(tmp, "shot-2000.png"), "x");
		fs.writeFileSync(path.join(tmp, "shot-1000.png"), "x");
		fs.writeFileSync(path.join(tmp, "not-a-shot.txt"), "x");
		const recs = reDeriveFromDisk(tmp);
		expect(recs.map((r) => path.basename(r.path))).toEqual(["shot-1000.png", "shot-2000.png"]);
		expect(recs[0]).toMatchObject({ label: "", url: "" });
		expect(recs[0].taken_at).toBe(new Date(1000).toISOString());
	});

	it("is [] for a directory with no screenshots", () => {
		expect(reDeriveFromDisk(tmp)).toEqual([]);
	});

	it("is [] for a missing directory", () => {
		expect(reDeriveFromDisk(path.join(tmp, "gone"))).toEqual([]);
	});
});

describe("ScreenshotLedger.all falls back when the manifest is lost", () => {
	it("re-derives from the screenshot dir when the manifest file is gone", () => {
		// The manifest and the shots share a dir here (no env var), so a lost
		// manifest is recoverable from the shot files sitting beside it.
		const shotDir = path.join(tmp, "pi-browser-1");
		fs.mkdirSync(shotDir, { recursive: true });
		fs.writeFileSync(path.join(shotDir, "shot-500.png"), "x");
		// The ledger resolves its dir from tmpdir/pi-browser-<pid>; point it at
		// our shotDir by constructing over an env with a matching pid layout.
		const led = new ScreenshotLedger({ HIVE_PR_ATTACHMENTS_DIR: shotDir });
		// No manifest written yet -> all() re-derives from disk.
		const all = led.all();
		expect(all).toHaveLength(1);
		expect(path.basename(all[0].path)).toBe("shot-500.png");
		expect(all[0].label).toBe("");
	});
});
