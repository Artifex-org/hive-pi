import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitDirOf, strandedIndexLock } from "../extensions/background/indexlock.ts";

// `git` removes `.git/index.lock` on its way out. A killed git never gets
// there, so a cancel leaves it — and the next command fails on "File exists",
// which names a file and not a cause. Three papercuts on 2026-08-18 are that
// sequence; one of them is literally "cancelling bg-2 left …/index.lock, so the
// next job failed immediately".

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "bg-lock-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

describe("strandedIndexLock", () => {
	it("says nothing when there is no lock", () => {
		expect(strandedIndexLock(repo())).toBe("");
	});

	it("names the exact path, and how to tell stranded from held", () => {
		const dir = repo();
		const gitDir = gitDirOf(dir)!;
		writeFileSync(join(gitDir, "index.lock"), "");

		const note = strandedIndexLock(dir);
		expect(note).toContain(join(gitDir, "index.lock"));
		expect(note).toContain("pgrep");
		// The distinction is the whole point: a lock with a live holder is doing
		// its job, and telling an agent to delete that would trade a failed
		// command for a corrupted index.
		expect(note).toContain("leave it alone");
	});

	it("says nothing outside a repo, or without a cwd", () => {
		const plain = mkdtempSync(join(tmpdir(), "bg-nolock-"));
		expect(strandedIndexLock(plain)).toBe("");
		expect(strandedIndexLock(undefined)).toBe("");
	});

	// It runs inside a cancel. A cancel that threw because its diagnostic failed
	// would be a worse bug than the one being diagnosed.
	it("never throws when git is missing or the lookup fails", () => {
		const failing = () => {
			throw new Error("git: not found");
		};
		expect(() => strandedIndexLock("/nowhere", { gitDir: failing as () => string | null })).not.toThrow();
	});

	// A linked worktree keeps its index under the COMMON dir's worktrees/<name>/,
	// not in the top-level .git — the papercut's path was exactly that shape.
	it("resolves the git dir of a linked worktree, not the main one", () => {
		const main = repo();
		writeFileSync(join(main, "f.txt"), "v1");
		execFileSync("git", ["add", "."], { cwd: main });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: main });
		const wt = join(mkdtempSync(join(tmpdir(), "bg-wt-")), "feature");
		mkdirSync(join(wt, ".."), { recursive: true });
		execFileSync("git", ["worktree", "add", "-q", wt, "-b", "feature"], { cwd: main });

		const gitDir = gitDirOf(wt)!;
		expect(gitDir).toContain("worktrees");
		writeFileSync(join(gitDir, "index.lock"), "");
		expect(strandedIndexLock(wt)).toContain(gitDir);
	});
});
