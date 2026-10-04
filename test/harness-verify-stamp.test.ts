/**
 * The writer guard's working-tree stamp must see CONTENT, not just paths.
 *
 * Measured false "writer produced no working-tree change" (papercuts
 * 2026-10-02T03:38, 2026-10-03T03:27): the stamp was plain
 * `git status --porcelain`, which prints ` M a.ts` before and after an edit to
 * an already-modified file, `?? new.py` before and after an edit to an
 * already-untracked file, and `?? dir/` for a whole untracked directory no
 * matter what changes inside it. A writer that did real work was folded to a
 * failure. Driven over a REAL git repo: a fake `.git` proves nothing here.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { treeStamp, writerMadeNoChange } from "../extensions/harness/verify.ts";
import { gitAvailable } from "./require-tools.ts";

const hasGit = gitAvailable();

function repoWith(file: string, body: string): string {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-treestamp-"));
	execSync("git init -q", { cwd: root, stdio: "ignore" });
	writeFileSync(join(root, file), body);
	execSync(`git add ${file} && git -c user.email=t@t -c user.name=t commit -q -m base`, { cwd: root, stdio: "ignore" });
	return root;
}

/** Stamp, mutate, stamp — and say whether the writer guard would call it a no-op. */
async function guardSaysNoChange(cwd: string, mutate: () => void): Promise<boolean> {
	const before = await treeStamp(cwd);
	expect(before).not.toBeNull();
	mutate();
	const after = await treeStamp(cwd);
	expect(after).not.toBeNull();
	return writerMadeNoChange(before, after);
}

describe.runIf(hasGit)("treeStamp — the writer guard's stamp", () => {
	it("sees an edit to an ALREADY-MODIFIED tracked file", async () => {
		const cwd = repoWith("code.ts", "one\n");
		writeFileSync(join(cwd, "code.ts"), "two\n");
		expect(await guardSaysNoChange(cwd, () => writeFileSync(join(cwd, "code.ts"), "three\n"))).toBe(false);
	});

	it("sees an edit to an ALREADY-UNTRACKED file", async () => {
		const cwd = repoWith("code.ts", "one\n");
		writeFileSync(join(cwd, "window_materials.py"), "def a(): pass\n");
		expect(
			await guardSaysNoChange(cwd, () => writeFileSync(join(cwd, "window_materials.py"), "def a(): pass\ndef b(): pass\n")),
		).toBe(false);
	});

	it("sees a new file inside an ALREADY-UNTRACKED directory", async () => {
		const cwd = repoWith("code.ts", "one\n");
		mkdirSync(join(cwd, "verification"));
		writeFileSync(join(cwd, "verification", "a.py"), "x = 1\n");
		expect(await guardSaysNoChange(cwd, () => writeFileSync(join(cwd, "verification", "b.py"), "y = 2\n"))).toBe(false);
	});

	it("is still identical when nothing changed — the guard keeps catching real no-ops", async () => {
		const cwd = repoWith("code.ts", "one\n");
		writeFileSync(join(cwd, "code.ts"), "two\n");
		writeFileSync(join(cwd, "new.py"), "z = 3\n");
		expect(await guardSaysNoChange(cwd, () => {})).toBe(true);
	});

	it("ignores files .gitignore excludes — build output is not the writer's change", async () => {
		const cwd = repoWith(".gitignore", "dist/\n");
		mkdirSync(join(cwd, "dist"));
		expect(await guardSaysNoChange(cwd, () => writeFileSync(join(cwd, "dist", "bundle.js"), "x"))).toBe(true);
	});

	// Review S6: stdout was decoded chunk by chunk, so a path that is not
	// UTF-8 came back with U+FFFD in it, the stat of that mangled path failed,
	// and every edit to the file stamped identically as "gone".
	it("sees an edit to an untracked file whose name is not UTF-8", async () => {
		const cwd = repoWith("code.ts", "one\n");
		const name = Buffer.concat([Buffer.from(join(cwd, "caf")), Buffer.from([0xe9]), Buffer.from(".txt")]);
		writeFileSync(name, "v1\n");
		expect(await guardSaysNoChange(cwd, () => writeFileSync(name, "version two\n"))).toBe(false);
	});

	it("is null outside a repo, which disables the check rather than failing the writer", async () => {
		expect(await treeStamp(mkdtempSync(join(tmpdir(), "hive-pi-treestamp-norepo-")))).toBeNull();
	});
});
