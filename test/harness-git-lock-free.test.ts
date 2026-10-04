/**
 * The writer stamp and the reviewer's diff capture must never write the index.
 *
 * They run beside the agent's own `git add`/`git commit`, and `verify.ts`
 * SIGKILLs a git call that overruns its timeout: a `git status` killed
 * mid-refresh leaves a stale 0-byte `index.lock` (20 of 20 reproductions), and
 * `git diff HEAD` rewrites a stat-dirty index EVEN UNDER --no-optional-locks.
 * Modelled on #104's test/git-no-optional-locks.test.ts.
 *
 * The observable that proves no lock was taken is the index itself: a read that
 * took the lock to refresh leaves a rewritten `.git/index` behind. Each fixture
 * makes the index stat-dirty (same bytes, an old mtime) and asserts the index
 * bytes are unchanged afterwards — real git, no stubs.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diffStamp, treeStamp } from "../extensions/harness/verify.ts";
import { captureReviewDiff } from "../extensions/subagent/reviewdiff.ts";
import { gitAvailable } from "./require-tools.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A committed repo with one real edit and one stat-dirty (unchanged) tracked file. */
function statDirtyRepo(): { dir: string; git: (...args: string[]) => void; indexHash: () => string } {
	const dir = mkdtempSync(join(tmpdir(), "hive-pi-lockfree-"));
	dirs.push(dir);
	const git = (...args: string[]) => {
		execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
	};
	git("init", "-q");
	writeFileSync(join(dir, "stale.txt"), "same\n");
	writeFileSync(join(dir, "edited.ts"), "one\n");
	git("add", ".");
	git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init");
	writeFileSync(join(dir, "edited.ts"), "two\n");
	const old = new Date("2001-01-01T00:00:00Z");
	utimesSync(join(dir, "stale.txt"), old, old);
	const indexHash = () => createHash("sha256").update(readFileSync(join(dir, ".git", "index"))).digest("hex");
	return { dir, git, indexHash };
}

describe.runIf(gitAvailable())("harness git reads take no index lock", () => {
	it("the fixture is real: `git --no-optional-locks diff HEAD` DOES rewrite this index", () => {
		// The negative control, and the reason treeStamp uses diff-index: the
		// flag alone does not make `git diff HEAD` lock-free.
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		execFileSync("git", ["-C", dir, "--no-optional-locks", "diff", "HEAD"], { stdio: "ignore" });
		expect(indexHash()).not.toBe(before);
	});

	it("verify: treeStamp", async () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		expect(await treeStamp(dir)).not.toBeNull();
		expect(indexHash()).toBe(before);
	});

	it("verify: diffStamp", async () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		expect(await diffStamp(dir)).toContain("edited.ts");
		expect(indexHash()).toBe(before);
	});

	it("reviewdiff: the working-tree capture — and a stat-only file is not reported as changed", () => {
		const { dir, indexHash } = statDirtyRepo();
		const before = indexHash();
		const diff = captureReviewDiff(dir, "Review the change.");
		expect(diff?.files).toEqual(["edited.ts"]);
		expect(diff?.text).toContain("+two");
		expect(indexHash()).toBe(before);
	});

	it("reviewdiff: the branch-vs-base capture", () => {
		const { dir, git, indexHash } = statDirtyRepo();
		git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qam", "edit");
		git("update-ref", "refs/remotes/origin/main", "HEAD~1");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		utimesSync(join(dir, "stale.txt"), new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
		const before = indexHash();
		const diff = captureReviewDiff(dir, "Review the branch.");
		expect(diff?.scope).toBe("branch vs its base");
		expect(diff?.files).toEqual(["edited.ts"]);
		expect(indexHash()).toBe(before);
	});
});
