/**
 * The worktree guard's rules.
 *
 * These are the cases the bridge it replaces could not be tested on at all,
 * because the logic lived in a bash script on one machine. The important ones
 * are the two directions of failure:
 *
 *   - failing OPEN where it should block (which is what the bridge did in every
 *     container, silently)
 *   - failing CLOSED where it should allow (which makes the harness unusable in
 *     every directory it does not understand)
 */

import { describe, expect, it } from "vitest";
import {
	decide,
	GUARD_MARKER,
	type GuardProbe,
	PULL_ONLY_MARKER,
} from "../extensions/guards-common/worktree-guard.ts";

/** A probe over a declared fake world: no git, no filesystem. */
function probeOf(options: {
	dirs?: string[];
	repo?: { commonDir: string; gitDir: string; topLevel: string } | null;
	files?: string[];
	/** Symlink map: lexical path → resolved real path (models realPath). */
	links?: Record<string, string>;
	/** Marker paths that are COMMITTED (relative to topLevel). */
	tracked?: string[];
}): GuardProbe {
	const dirs = new Set(options.dirs ?? ["/repo", "/repo/src"]);
	const files = new Set(options.files ?? []);
	const links = options.links ?? {};
	return {
		existingDir: (path) => {
			let current = path;
			while (current && current !== "/" && !dirs.has(current)) {
				current = current.slice(0, current.lastIndexOf("/")) || "/";
			}
			return dirs.has(current) ? current : null;
		},
		realPath: (path) => links[path] ?? path,
		locate: () => options.repo ?? null,
		fileExists: (path) => files.has(path),
		isTracked: (_top, rel) => (options.tracked ?? []).includes(rel),
	};
}

const MAIN = { commonDir: "/repo/.git", gitDir: "/repo/.git", topLevel: "/repo" };
const LINKED = { commonDir: "/bare/repo.git", gitDir: "/bare/repo.git/worktrees/task", topLevel: "/wt/task" };

describe("fails open on what it cannot determine", () => {
	it("allows when there is no file path", () => {
		expect(decide(undefined, "Edit", probeOf({ repo: MAIN }))).toEqual({ kind: "allow" });
	});

	it("allows when no ancestor directory exists", () => {
		expect(decide("/nowhere/at/all/x.ts", "Write", probeOf({ dirs: [], repo: MAIN }))).toEqual({ kind: "allow" });
	});

	it("allows outside any git repo", () => {
		// A guard that blocks when confused makes every unfamiliar directory
		// unusable. This is the deliberate half of failing open.
		expect(decide("/repo/src/a.ts", "Edit", probeOf({ repo: null }))).toEqual({ kind: "allow" });
	});
});

describe("the main worktree", () => {
	it("BLOCKS when the repo opted in", () => {
		const verdict = decide("/repo/src/a.ts", "Edit", probeOf({ repo: MAIN, files: [`/repo/${GUARD_MARKER}`] }));
		expect(verdict.kind).toBe("block");
		if (verdict.kind !== "block") return;
		expect(verdict.reason).toContain("worktree-protected");
		expect(verdict.reason).toContain("/repo/src/a.ts");
		// The remediation is the point of the message: a block with no way
		// forward just stalls whoever hit it.
		expect(verdict.reason).toContain("gwq add -b");
		// ...and the pathless form is EROFS in a sandbox, where gwq's default
		// basedir is the read-only shared worktree root. Without this line the
		// remediation hands a sandboxed agent the one command it cannot run —
		// measured three times on 2026-08-18, twice blocking (HIV-2001).
		expect(verdict.reason).toContain("Read-only file system");
		expect(verdict.reason).toContain("gwq add -b <task-name> <writable-dir>/<task-name>");
	});

	it("allows when the repo did NOT opt in", () => {
		// Opt-in is what keeps this from blocking every ordinary clone.
		expect(decide("/repo/src/a.ts", "Edit", probeOf({ repo: MAIN, files: [] }))).toEqual({ kind: "allow" });
	});

	it("names the repo, not the file, so the message says what to fix", () => {
		const verdict = decide("/repo/src/a.ts", "Write", probeOf({ repo: MAIN, files: [`/repo/${GUARD_MARKER}`] }));
		if (verdict.kind !== "block") throw new Error("expected block");
		expect(verdict.reason).toContain("BLOCKED: repo is");
	});

	// A COMMITTED marker cannot mean "this directory is the anchor": it arrives
	// with every `git clone`, and a clone is a main worktree. `.worktree-guard`
	// is tracked in Aurora, hive-pi and Borealis-Ops, so the rule above fired on
	// every disposable clone anyone made — a rebase staging area under /tmp, a
	// nested recovery clone, a sandbox's granted workspace. Four papercuts
	// 2026-08-15..19, one blocking, all "blocked as 'the main worktree'".
	it("ALLOWS when the marker is committed — every clone has it", () => {
		const verdict = decide(
			"/repo/src/a.ts",
			"Edit",
			probeOf({ repo: MAIN, files: [`/repo/${GUARD_MARKER}`], tracked: [GUARD_MARKER] }),
		);
		expect(verdict.kind).toBe("allow");
	});

	it("says WHY it allowed, and how to protect a checkout that really is the anchor", () => {
		const verdict = decide(
			"/repo/src/a.ts",
			"Edit",
			probeOf({ repo: MAIN, files: [`/repo/${GUARD_MARKER}`], tracked: [GUARD_MARKER] }),
		);
		if (verdict.kind !== "allow") throw new Error("expected allow");
		// Silent would be wrong in the other direction: an operator who meant to
		// protect this directory has to learn that it is not protected, and the
		// fix is the one the pull-only marker already uses.
		expect(verdict.note).toContain("COMMITTED");
		expect(verdict.note).toContain("info/exclude");
		expect(verdict.note).toContain(PULL_ONLY_MARKER);
	});

	// The anchor keeps its protection: its marker is untracked (one line in
	// info/exclude), exactly as `.worktree-pull-only` is done.
	it("still BLOCKS when the marker is untracked", () => {
		const verdict = decide("/repo/src/a.ts", "Edit", probeOf({ repo: MAIN, files: [`/repo/${GUARD_MARKER}`] }));
		expect(verdict.kind).toBe("block");
		if (verdict.kind !== "block") return;
		expect(verdict.reason).toContain("untracked");
	});

	// Tracked-ness is asked ONLY about the marker. A repo where some other file
	// is committed must not read as "marker committed".
	it("asks about the marker, not about any tracked file", () => {
		const verdict = decide(
			"/repo/src/a.ts",
			"Edit",
			probeOf({ repo: MAIN, files: [`/repo/${GUARD_MARKER}`], tracked: ["README.md"] }),
		);
		expect(verdict.kind).toBe("block");
	});
});

describe("linked worktrees", () => {
	it("allows an ordinary task worktree — this is where work belongs", () => {
		expect(decide("/wt/task/src/a.ts", "Edit", probeOf({ dirs: ["/wt/task/src"], repo: LINKED }))).toEqual({
			kind: "allow",
		});
	});

	it("BLOCKS a pull-only worktree", () => {
		// The pull-only base is also hive-pi's stow source for live harness
		// config, so an edit there is an uncommitted change other sessions read.
		const verdict = decide(
			"/wt/task/src/a.ts",
			"Edit",
			probeOf({ dirs: ["/wt/task/src"], repo: LINKED, files: [`/wt/task/${PULL_ONLY_MARKER}`] }),
		);
		expect(verdict.kind).toBe("block");
		if (verdict.kind !== "block") return;
		expect(verdict.reason).toContain("PULL-ONLY");
		expect(verdict.reason).toContain("gwq add -b");
	});

	it("does not apply the main-worktree marker to a linked worktree", () => {
		// A guarded repo's marker is at the MAIN root and is visible from every
		// worktree's git dir; keying off it here would block all real work.
		expect(
			decide("/wt/task/src/a.ts", "Edit", probeOf({ dirs: ["/wt/task/src"], repo: LINKED, files: [`/wt/task/${GUARD_MARKER}`] })),
		).toEqual({ kind: "allow" });
	});
});

describe("main vs linked is decided on resolved paths", () => {
	it("treats equal common/git dirs as the main worktree", () => {
		const same = { commonDir: "/repo/.git", gitDir: "/repo/.git", topLevel: "/repo" };
		const verdict = decide("/repo/a.ts", "Edit", probeOf({ dirs: ["/repo"], repo: same, files: [`/repo/${GUARD_MARKER}`] }));
		expect(verdict.kind).toBe("block");
	});

	it("treats differing dirs as linked even when the topLevel looks similar", () => {
		const linkedish = { commonDir: "/repo/.git", gitDir: "/repo/.git/worktrees/x", topLevel: "/repo" };
		expect(decide("/repo/a.ts", "Edit", probeOf({ dirs: ["/repo"], repo: linkedish, files: [`/repo/${GUARD_MARKER}`] }))).toEqual({
			kind: "allow",
		});
	});
});
