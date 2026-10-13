import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkScratchDir, writableScratchRoot } from "./scratch.ts";

describe("writableScratchRoot", () => {
	const home = "/home/u";
	const scratch = path.join(home, ".hive", "scratch");

	it("is the launch's own scratch child when cwd is inside one", () => {
		expect(writableScratchRoot(path.join(scratch, "launch-1", "repo", "test"), home)).toBe(path.join(scratch, "launch-1"));
		expect(writableScratchRoot(path.join(scratch, "launch-1"), home)).toBe(path.join(scratch, "launch-1"));
	});

	it("is the shared parent for an ordinary checkout", () => {
		expect(writableScratchRoot("/home/u/repos/hive-pi", home)).toBe(scratch);
	});

	it("is the shared parent when cwd is the parent itself", () => {
		expect(writableScratchRoot(scratch, home)).toBe(scratch);
	});
});

describe("mkScratchDir", () => {
	it("creates a private directory under the writable scratch root", () => {
		const dir = mkScratchDir("scratch-helper-test-");
		try {
			expect(path.dirname(dir)).toBe(writableScratchRoot());
			expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
