/**
 * EXDEV fallback for handoff consume — deterministic core.
 *
 * `consumeHandoff` moves a pending seed with `renameSync`, which throws EXDEV
 * when the checkout and the git dir live on different filesystems (a
 * `--separate-git-dir` repo, a gitdir pointer elsewhere). Here `renameSync`
 * ALWAYS throws EXDEV while every other fs op stays real, so this suite proves
 * the copy+unlink fallback preserves consume-once with no duplicates and no
 * checkout litter. The cross-device reality check against a genuine EXDEV
 * lives in agenda-handoff.test.ts where the platform offers two filesystems.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

// Mutable mock control must come from vi.hoisted: the factory below is
// hoisted above all imports, so a plain top-level `let` is unreachable there.
const mockControl = vi.hoisted(() => ({ failPendingUnlink: false }));

vi.mock("node:fs", async (importOriginal) => {
	const mod = await importOriginal<typeof import("node:fs")>();
	const exdev = (): never => {
		const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
		err.code = "EXDEV";
		throw err;
	};
	// With failPendingUnlink set, unlinkSync refuses only the pending-source
	// unlink (paths carrying a consumed name pass through): that stages
	// copy-ok-but-unlink-fails, the one ordering that could leave two live
	// seeds. Default off, so the success paths exercise the plain fallback.
	const realUnlink = mod.unlinkSync;
	return {
		...mod,
		renameSync: exdev,
		unlinkSync: ((path: Parameters<typeof mod.unlinkSync>[0]) => {
			if (
				mockControl.failPendingUnlink &&
				typeof path === "string" &&
				!path.includes("handoff-consumed-")
			) {
				const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(path);
		}) as typeof mod.unlinkSync,
	};
});

import {
	consumeHandoff,
	handoffPath,
	legacyHandoffPath,
	writeHandoff,
} from "../extensions/agenda/handoff.ts";

function makeWorktree(): { base: string; wt: string } {
	const base = mkdtempSync(join(tmpdir(), "hive-pi-handoff-xdev-"));
	execSync(
		`git init -q "${base}" && git -C "${base}" config user.email t@t.t && git -C "${base}" config user.name t && git -C "${base}" commit -q --allow-empty -m init`,
		{ stdio: "pipe" },
	);
	const wt = `${base}-wt`;
	execSync(`git -C "${base}" worktree add -q "${wt}"`, { stdio: "pipe" });
	return { base, wt };
}

describe("consume under EXDEV (rename unavailable)", () => {
	it("moves a legacy seed to the git dir with contents intact, exactly once", () => {
		const { wt } = makeWorktree();
		const legacy = legacyHandoffPath(wt);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "# Handoff\nexdev legacy content", "utf8");

		const seed = consumeHandoff(wt, 7001);
		expect(seed).toContain("exdev legacy content");
		expect(existsSync(legacy)).toBe(false);
		const consumed = join(dirname(handoffPath(wt)), "handoff-consumed-7001.md");
		expect(readFileSync(consumed, "utf8")).toContain("exdev legacy content");
		expect(consumeHandoff(wt)).toBeNull();
		expect(execSync(`git -C "${wt}" status --porcelain`, { encoding: "utf8" })).toBe("");
	});

	it("moves a primary pending seed the same way", () => {
		const { wt } = makeWorktree();
		writeHandoff(wt, "# Handoff\nexdev primary content");
		expect(consumeHandoff(wt, 7002)).toContain("exdev primary content");
		expect(existsSync(handoffPath(wt))).toBe(false);
		expect(consumeHandoff(wt)).toBeNull();
	});

	it("a stale twin is still removed so it can never inject later", () => {
		const { wt } = makeWorktree();
		writeHandoff(wt, "# Handoff\nnewer content");
		const legacy = legacyHandoffPath(wt);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "# Handoff\nstale twin", "utf8");

		const seed = consumeHandoff(wt, 7003);
		expect(seed).toBeTruthy();
		// Whichever candidate won, the other is gone — no second injection lives on.
		expect(existsSync(legacy)).toBe(false);
		expect(consumeHandoff(wt)).toBeNull();
	});

	it("copy-ok-but-unlink-fails leaves no duplicate: null, seed still pending, nothing consumed", () => {
		// The mocked unlinkSync refuses the pending-source unlink, so the move
		// cannot complete — and the rollback must remove the copy again.
		mockControl.failPendingUnlink = true;
		try {
			const { base } = makeWorktree();
		const gitDir = resolve(base, execSync(`git -C "${base}" rev-parse --git-dir`, { encoding: "utf8" }).trim());
		const legacy = legacyHandoffPath(base);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "# Handoff\nrollback content", "utf8");

		expect(consumeHandoff(base, 7004)).toBeNull();
		// Source intact (still exactly one pending seed)...
		expect(readFileSync(legacy, "utf8")).toContain("rollback content");
		// ...and no consumed copy left beside it (rollback removed the copy).
		expect(readdirSync(join(gitDir, "handoff")).filter((f) => f.includes("handoff-consumed"))).toEqual([]);
		} finally {
			mockControl.failPendingUnlink = false;
		}
	});
});
