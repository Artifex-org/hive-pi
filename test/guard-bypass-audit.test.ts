/**
 * Guard bypass audit — negative controls pinned in CI (HIV-1266 part B).
 *
 * Claude Code and Devin BOTH patched three guard-bypass classes within the same
 * weeks of 2026 (KB `harness-frontier-2026-08-wave3.md`): if two vendors patch
 * the same holes at the same time, they are being found in the wild. This file
 * is the standing regression net for those classes against pi's write guard —
 * same spirit as `harness/heldout.ts`, whose exploit patterns are assembled by
 * concatenation so the scanner never trips over its own source.
 *
 * The classes:
 *
 *   1. SYMLINK WRITE REDIRECT — an approved edit path that resolves through a
 *      symlink into a protected worktree. (patched Aug 1 / 2.1.210-222)
 *   2. WORKTREE-ISOLATION ESCAPE — routing a git mutation at a different repo
 *      via `--git-dir` / `GIT_DIR` env, past a cwd-scoped guard. (2.1.210/216/222)
 *   3. SHELL-PARSE BYPASS — invisible Unicode, bidi controls, tabs, quoting that
 *      make a substring/regex matcher miss what the shell will run.
 *
 * SCOPE. This audit covers the guard pi OWNS and ships: the native write guard
 * in `guards-common/worktree-guard.ts` (Edit/Write, and — via `guards-bridge` —
 * the same `decide` for every harness, factory container included). The Bash
 * command policy (`~/.claude/hooks/pre-bash-dispatch.sh`) is deliberately
 * BRIDGED, not ported: it encodes machine-specific facts (kubectl contexts,
 * which checkouts are guarded) that have no meaning in a factory container,
 * where failing open is correct. Class 3 is a substring-matcher's weakness and
 * lives in that bash script; the tests below therefore pin the structural
 * reason the NATIVE guard is immune to it — it resolves real paths, it never
 * matches command substrings — rather than re-testing a script this package
 * does not contain.
 *
 * TIERS. The decision logic and the real symlink resolver are pinned purely
 * (fake probe) and with real filesystem symlinks — both run everywhere. The
 * end-to-end `realProbe` + real-git integration for the GIT_DIR escape needs a
 * `git` binary the CI base image (node:alpine) does not ship, so it is gated on
 * git being present: it runs on any dev machine and skips (never fails) without.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	decide,
	GUARD_MARKER,
	type GitLocation,
	type GuardProbe,
	PULL_ONLY_MARKER,
	realProbe,
} from "../extensions/guards-common/worktree-guard.ts";
import { gitAvailable } from "./require-tools.ts";

const GIT_AVAILABLE = gitAvailable();

// Invisible / bidi characters, built by code point so this file's own source
// stays greppable and no scanner trips over a literal it hunts for.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const WORD_JOINER = String.fromCharCode(0x2060);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const TAB = String.fromCharCode(0x09);

const MAIN_GUARDED: GitLocation = { commonDir: "/repo/.git", gitDir: "/repo/.git", topLevel: "/repo" };
const LINKED: GitLocation = { commonDir: "/bare/repo.git", gitDir: "/bare/repo.git/worktrees/task", topLevel: "/wt/base" };

/**
 * A probe over a declared world: symlink map + which worktree each directory
 * belongs to. No git, no filesystem — pins the DECISION, which is the part that
 * has to stay correct across every harness.
 */
function probeWorld(opts: {
	links?: Record<string, string>;
	dirs: string[];
	locate: (dir: string) => GitLocation | null;
	files?: string[];
}): GuardProbe {
	const dirs = new Set(opts.dirs);
	const files = new Set(opts.files ?? []);
	const links = opts.links ?? {};
	return {
		realPath: (p) => links[p] ?? p,
		existingDir: (path) => {
			let current = path;
			while (current && current !== "/" && !dirs.has(current)) current = dirname(current);
			return dirs.has(current) ? current : null;
		},
		locate: (dir) => opts.locate(dir),
		fileExists: (p) => files.has(p),
		// Untracked: the audit is about what the guard must still BLOCK, and an
		// untracked marker is the case that blocks.
		isTracked: () => false,
	};
}

describe("class 1 — symlink write redirect (decision)", () => {
	it("BLOCKS a leaf symlink (in an allowed worktree) that redirects into a pull-only base", () => {
		// The lexical path is an allowed task worktree; realPath redirects the
		// write into the pull-only base. A guard that judged the lexical parent
		// would allow it — the whole point of resolving first.
		const verdict = decide(
			"/wt/task/innocent.ts",
			"Edit",
			probeWorld({
				links: { "/wt/task/innocent.ts": "/wt/base/src/real.ts" },
				dirs: ["/wt/task", "/wt/base/src"],
				locate: () => LINKED,
				files: [join("/wt/base", PULL_ONLY_MARKER)],
			}),
		);
		expect(verdict.kind).toBe("block");
		if (verdict.kind !== "block") return;
		expect(verdict.reason).toContain("PULL-ONLY");
		expect(verdict.reason).toContain("via symlink");
	});

	it("BLOCKS a leaf symlink that redirects into a guarded MAIN worktree", () => {
		const verdict = decide(
			"/outside/innocent.ts",
			"Edit",
			probeWorld({
				links: { "/outside/innocent.ts": "/repo/src/real.ts" },
				dirs: ["/outside", "/repo/src"],
				locate: (dir) => (dir.startsWith("/repo") ? MAIN_GUARDED : null),
				files: [join("/repo", GUARD_MARKER)],
			}),
		);
		expect(verdict.kind).toBe("block");
	});

	it("does NOT redirect an ordinary path, and does not falsely claim a symlink", () => {
		const verdict = decide(
			"/repo/src/real.ts",
			"Edit",
			probeWorld({
				dirs: ["/repo/src"],
				locate: () => MAIN_GUARDED,
				files: [join("/repo", GUARD_MARKER)],
			}),
		);
		if (verdict.kind !== "block") throw new Error("expected block");
		expect(verdict.reason).not.toContain("via symlink");
	});
});

describe("class 1 — symlink write redirect (real resolver, filesystem only)", () => {
	// realProbe.realPath / existingDir use only fs (lstat/readlink/realpath), no
	// git binary — so the actual resolver is pinned everywhere, CI included.
	let root: string;
	let guarded: string;
	let outside: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "guard-sym-"));
		guarded = join(root, "guarded", "src");
		outside = join(root, "outside");
		mkdirSync(guarded, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(guarded, "real.ts"), "// protected\n");
	});

	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("realPath follows a leaf symlink pointing at an existing protected file", () => {
		const link = join(outside, "innocent.ts");
		if (!existsSync(link)) symlinkSync(join(guarded, "real.ts"), link);
		expect(realProbe.realPath(link)).toBe(join(guarded, "real.ts"));
	});

	it("realPath follows a leaf symlink whose target does not exist yet (lstat, not exists)", () => {
		const link = join(outside, "newfile.ts");
		if (!existsSync(link)) symlinkSync(join(guarded, "brand-new.ts"), link);
		expect(realProbe.realPath(link)).toBe(join(guarded, "brand-new.ts"));
	});

	it("existingDir resolves a symlinked PARENT directory to its real location", () => {
		const dirLink = join(outside, "srclink");
		if (!existsSync(dirLink)) symlinkSync(guarded, dirLink);
		expect(realProbe.existingDir(join(dirLink))).toBe(guarded);
	});

	it("leaves an ordinary path unchanged", () => {
		const plain = join(guarded, "real.ts");
		expect(realProbe.realPath(plain)).toBe(plain);
	});
});

describe.skipIf(!GIT_AVAILABLE)("class 2 — worktree-isolation escape via git env (real git)", () => {
	// GIT_DIR wins over `git -C <dir>` (verified), so an inherited value would
	// make realProbe.locate report a DIFFERENT repo than the edit lands in. The
	// probe scrubs the git env overrides; these pin that it stays cwd-honest.
	let root: string;
	let guarded: string;
	let decoy: string;

	const git = (cwd: string, ...args: string[]) => {
		const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
		if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr ?? "spawn error"}`);
	};

	function withEnv(vars: Record<string, string>, fn: () => void): void {
		const saved: Record<string, string | undefined> = {};
		for (const k of Object.keys(vars)) {
			saved[k] = process.env[k];
			process.env[k] = vars[k];
		}
		try {
			fn();
		} finally {
			for (const k of Object.keys(vars)) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	}

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "guard-env-"));
		guarded = join(root, "guarded");
		decoy = join(root, "decoy");
		mkdirSync(join(guarded, "src"), { recursive: true });
		mkdirSync(decoy, { recursive: true });
		for (const repo of [guarded, decoy]) {
			git(repo, "init", "-q");
			git(repo, "config", "user.email", "a@b.c");
			git(repo, "config", "user.name", "a");
		}
		writeFileSync(join(guarded, "src", "real.ts"), "// protected\n");
		git(guarded, "add", "-A");
		git(guarded, "commit", "-qm", "init");
		// The marker is written AFTER the commit, and so stays UNTRACKED — which
		// is how a real anchor is set up (one line in info/exclude) and, since
		// 2026-08-19, what makes it protective at all: a COMMITTED marker travels
		// with every clone and therefore cannot mark one directory as the anchor.
		// Committing it here would make this whole fixture a clone-shaped repo
		// that the guard correctly allows, and every case below would pass
		// vacuously — the audit would report a guard that blocks nothing.
		writeFileSync(join(guarded, GUARD_MARKER), "");
		writeFileSync(join(decoy, "x"), "");
		git(decoy, "add", "-A");
		git(decoy, "commit", "-qm", "init");
	});

	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("baseline: a direct edit in the guarded worktree BLOCKS", () => {
		expect(decide(join(guarded, "src", "real.ts"), "Edit", realProbe).kind).toBe("block");
	});

	it("still BLOCKS a guarded edit when GIT_DIR points at another repo", () => {
		withEnv({ GIT_DIR: join(decoy, ".git") }, () => {
			expect(decide(join(guarded, "src", "real.ts"), "Edit", realProbe).kind).toBe("block");
		});
	});

	it("still BLOCKS when GIT_DIR + GIT_WORK_TREE both point at the decoy", () => {
		withEnv({ GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy }, () => {
			expect(decide(join(guarded, "src", "real.ts"), "Edit", realProbe).kind).toBe("block");
		});
	});

	it("locate() reports the honest cwd repo, not the env-injected one", () => {
		withEnv({ GIT_DIR: join(decoy, ".git") }, () => {
			const loc = realProbe.locate(join(guarded, "src"));
			expect(loc).not.toBeNull();
			expect(loc?.gitDir).not.toContain("decoy");
			expect(loc?.topLevel).not.toContain("decoy");
		});
	});

	it("a real leaf symlink from outside INTO the guarded worktree BLOCKS end-to-end", () => {
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		const link = join(outside, "innocent.ts");
		if (!existsSync(link)) symlinkSync(join(guarded, "src", "real.ts"), link);
		const verdict = decide(link, "Edit", realProbe);
		expect(verdict.kind).toBe("block");
		if (verdict.kind !== "block") return;
		expect(verdict.reason).toContain("via symlink");
	});
});

describe("class 3 — shell-parse bypass (structural immunity of the native guard)", () => {
	// The native guard never substring/regex-matches a command; it resolves a
	// real path. So invisible/bidi/tab characters cannot hide WHERE a write
	// lands — the byte-exact path either sits in a guarded worktree or it does
	// not. These pin that immunity; the command-string matcher that IS
	// vulnerable to this class is the bridged bash hook, out of this package.
	const guardedProbe = () =>
		probeWorld({
			dirs: ["/repo/src"],
			locate: (dir) => (dir.startsWith("/repo") ? MAIN_GUARDED : null),
			files: [join("/repo", GUARD_MARKER)],
		});

	const hidden: Array<[string, string]> = [
		["zero-width space", `real${ZERO_WIDTH_SPACE}.ts`],
		["word joiner", `re${WORD_JOINER}al.ts`],
		["bidi override", `${RTL_OVERRIDE}real.ts`],
		["embedded tab", `re${TAB}al.ts`],
	];

	for (const [label, name] of hidden) {
		it(`a filename carrying a ${label} inside the guarded worktree still BLOCKS`, () => {
			expect(decide(`/repo/src/${name}`, "Edit", guardedProbe()).kind).toBe("block");
		});
	}

	it("a hidden-char filename OUTSIDE any repo is still allowed (no over-block)", () => {
		const probe = probeWorld({ dirs: ["/outside"], locate: () => null });
		expect(decide(`/outside/x${ZERO_WIDTH_SPACE}.txt`, "Write", probe)).toEqual({ kind: "allow" });
	});
});
