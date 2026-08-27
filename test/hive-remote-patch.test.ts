/**
 * The working-tree diff a browser asks for (HIV-1421, wired up in HIV-1769).
 *
 * Against a REAL git repository, because every interesting case here is a fact
 * about git's own behaviour rather than about our string handling: an untracked
 * file produces nothing from `git diff HEAD`, and the invocation that does
 * produce its diff signals success with a non-zero exit.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectPatch, MAX_PATCH_BYTES } from "../extensions/hive-remote/worktree.ts";

const root = mkdtempSync(join(tmpdir(), "hive-patch-"));
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

beforeAll(() => {
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(root, "tracked.ts"), "const a = 1;\n");
	writeFileSync(join(root, "untouched.ts"), "const b = 2;\n");
	git("add", "-A");
	git("commit", "-qm", "base");

	// One tracked file modified, one brand-new untracked file.
	writeFileSync(join(root, "tracked.ts"), "const a = 2;\n");
	writeFileSync(join(root, "fresh.ts"), "const c = 3;\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const known = (...paths: string[]) => (p: string) => paths.includes(p);

describe("collectPatch", () => {
	it("returns the diff of a modified tracked file", () => {
		const got = collectPatch(root, "tracked.ts", known("tracked.ts"));
		expect(got.reason).toBeUndefined();
		expect(got.patch).toContain("-const a = 1;");
		expect(got.patch).toContain("+const a = 2;");
	});

	// THE CASE THAT SILENTLY RETURNS NOTHING IF YOU GET IT WRONG. An untracked
	// file has no HEAD side, so `git diff HEAD` says nothing about it — and the
	// invocation that does produce its diff, `--no-index`, exits 1 precisely
	// BECAUSE there is a difference. A helper that reads any non-zero exit as
	// failure keeps only the empty answers, and the viewer shows a new file as
	// unchanged.
	it("returns the add-everything diff of an untracked file", () => {
		const got = collectPatch(root, "fresh.ts", known("fresh.ts"));
		expect(got.reason).toBeUndefined();
		expect(got.patch).toContain("+const c = 3;");
	});

	// Empty is a legitimate answer, but it must never arrive bare: a blank viewer
	// and a viewer saying "no changes" look identical to a reader, and only one
	// of them is honest.
	it("says WHY when there is nothing to show", () => {
		const got = collectPatch(root, "untouched.ts", known("untouched.ts"));
		expect(got.patch).toBe("");
		expect(got.reason).toBe("no changes against HEAD");
	});

	// The boundary. A diff request names a file by a string that came from a
	// browser; without this it is an arbitrary read on the developer's machine.
	it("refuses a path this session never reported as changed", () => {
		const got = collectPatch(root, "../../etc/passwd", known("tracked.ts"));
		expect(got.patch).toBe("");
		expect(got.reason).toBe("not a file this session reported as changed");
	});

	it("refuses an empty path and one carrying a NUL", () => {
		expect(collectPatch(root, "", known("")).patch).toBe("");
		expect(collectPatch(root, "a\0b", known("a\0b")).reason).toBe("not a path this session can read");
	});

	it("truncates honestly rather than sending a megabyte-plus body", () => {
		writeFileSync(join(root, "big.ts"), `const x = "${"y".repeat(MAX_PATCH_BYTES + 4096)}";\n`);
		const got = collectPatch(root, "big.ts", known("big.ts"));
		expect(got.truncated).toBe(true);
		expect(got.patch.length).toBe(MAX_PATCH_BYTES);
	});
});

// Sandbox scaffolding is excluded from the file LIST for a reason; answering a
// diff for one would put in the browser exactly the content the list withheld.
describe("collectPatch and sandbox masks", () => {
	const sandbox = mkdtempSync(join(tmpdir(), "hive-patch-masked-"));
	beforeAll(() => {
		execFileSync("git", ["-C", sandbox, "init", "-q", "-b", "main"]);
		mkdirSync(join(sandbox, ".claude"), { recursive: true });
		writeFileSync(join(sandbox, ".hive-sandbox.json"), '{"filesystem":{}}', { mode: 0o600 });
		writeFileSync(join(sandbox, ".mcp.json"), "");
		chmodSync(join(sandbox, ".mcp.json"), 0o444);
	});
	afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

	it("refuses to diff a mask, even one the caller claims to know", () => {
		const got = collectPatch(sandbox, ".mcp.json", known(".mcp.json"));
		expect(got.patch).toBe("");
		expect(got.reason).toBe("sandbox scaffolding, not this agent's work");
	});
});
