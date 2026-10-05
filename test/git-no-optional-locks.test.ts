/**
 * Harness git reads must never write the index.
 *
 * `git status` and `git diff HEAD` refresh a stat-dirty index and write it back,
 * taking `.git/index.lock` while they do. The harness runs them in the
 * background beside the agent's own `git add`/`git commit`, which then fail with
 * "index.lock exists" and no git process left to see (17 papercuts). Measured
 * 2026-10-04: a `git status` loop beside 150 commits failed 24 of them; with
 * `--no-optional-locks` none failed. See extensions/hive-common/git.ts.
 *
 * The observable that proves the lock was never taken is the index itself: a
 * read that took the lock to refresh leaves a rewritten `.git/index` behind. So
 * each test makes the index stat-dirty (same content, an old mtime) and asserts
 * the index bytes are unchanged after the harness read — real git, no stubs.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { uncommittedCount } from "../extensions/gate/index.ts";
import { collectWorkDiff } from "../extensions/harness/heldout.ts";
import { collectWorktree } from "../extensions/hive-remote/worktree.ts";
import { realDeps, repoProbe } from "../extensions/readiness/probes.ts";
import filerankExtension from "../extensions/filerank/index.ts";
import { createFakePi } from "./fake-pi.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A committed repo whose one tracked file is stat-dirty: same bytes, old mtime. */
function statDirtyRepo(): { dir: string; indexHash: () => string } {
	const dir = mkdtempSync(join(tmpdir(), "git-optional-locks-"));
	dirs.push(dir);
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
	git("init", "-q");
	writeFileSync(join(dir, "tracked.txt"), "one\n");
	git("add", "tracked.txt");
	git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init");
	const old = new Date("2001-01-01T00:00:00Z");
	utimesSync(join(dir, "tracked.txt"), old, old);
	const indexHash = () => createHash("sha256").update(readFileSync(join(dir, ".git", "index"))).digest("hex");
	return { dir, indexHash };
}

describe("harness git reads take no optional index lock", () => {
	it("the fixture is real: a plain `git status` DOES rewrite this index", () => {
		// The negative control. Without it a fixture that never dirtied the index
		// would make every assertion below pass for the wrong reason.
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		// Explicit negative control: launched harnesses inherit optional locks
		// disabled. Only this counterexample must opt in to index refreshes.
		execFileSync("git", ["-C", dir, "status", "--porcelain"], { stdio: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" } });
		expect(indexHash()).not.toBe(before);
	});

	it("gate: uncommittedCount", async () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		expect(await uncommittedCount(dir)).toBe(0);
		expect(indexHash()).toBe(before);
	});

	it("hive-remote: collectWorktree", () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		expect(collectWorktree(dir)).not.toBeNull();
		expect(indexHash()).toBe(before);
	});

	it("readiness: repoProbe", async () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		expect((await repoProbe(realDeps(() => [], dir))).status).toBe("ready");
		expect(indexHash()).toBe(before);
	});

	it("harness: the held-out scan's work diff", async () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		expect(await collectWorkDiff(dir)).toBe("");
		expect(indexHash()).toBe(before);
	});

	it("filerank: the background status refresh at load", async () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		const home = mkdtempSync(join(tmpdir(), "filerank-home-"));
		dirs.push(home);
		const prevHome = process.env.HOME;
		const prevCwd = process.cwd();
		process.env.HOME = home;
		process.chdir(dir);
		try {
			filerankExtension(createFakePi().api);
			// Fire-and-forget by design (nothing awaits it), so wait out its own
			// ceiling: two chained git calls, each capped at 800 ms.
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		} finally {
			process.chdir(prevCwd);
			process.env.HOME = prevHome;
		}
		expect(indexHash()).toBe(before);
	});
});
