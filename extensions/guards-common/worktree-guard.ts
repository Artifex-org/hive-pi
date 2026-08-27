/**
 * The worktree guard, native.
 *
 * WHY THIS IS A PORT AND NOT A BRIDGE. `guards-bridge.ts` used to shell out to
 * `~/.claude/hooks/worktree-guard.sh`, on the rule that the bash script was the
 * single source of truth across Claude Code, opencode and pi. That rule was
 * already only half true — opencode has carried its own TypeScript port
 * (`opencode/plugin/worktree-guard.ts`) for as long as it has had plugins — and
 * the bridge cost more than the sharing was worth:
 *
 *   1. **hive-pi is a package.** The Hive Code Factory and the Aurora in-app
 *      agent install it into containers with no `~/.claude` at all. The bridge
 *      fails OPEN there (`if (!existsSync(script)) return null` → allow), so
 *      the guard reported healthy and enforced nothing. Success-shaped nothing.
 *   2. **It ran a bash process per edit**, which then ran three `git rev-parse`
 *      calls of its own — inside a `tool_call` handler that pi awaits serially,
 *      so it sat directly in the agent loop. This version makes ONE git call.
 *
 * The decision itself is pure and takes an injected probe, so the rules are
 * tested with no git and no filesystem. That is the part that has to stay
 * correct; the probe is the part that cannot be unit-tested anyway.
 *
 * Behaviour is deliberately identical to the script it replaces, including the
 * remediation text — someone who hits this in pi and in Claude Code should not
 * have to notice which harness they are in.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * Git environment variables that override cwd-based repo discovery.
 *
 * `git -C <dir> rev-parse` does NOT win over an inherited `GIT_DIR`: the env var
 * decides which repo git reports, regardless of `-C` (verified — with
 * `GIT_DIR=/decoy/.git`, `git -C /main rev-parse --git-dir` answers `/decoy`).
 * A caller who exports one of these can therefore make the guard locate a
 * DIFFERENT repo than the one the edit lands in — e.g. relabel a protected main
 * worktree as a harmless linked one, or vice-versa. The guard's discovery must
 * be honest and cwd-based, so it is run with all of these scrubbed. This is the
 * worktree-isolation-escape class (Claude Code 2.1.210/216/222).
 */
const GIT_ENV_OVERRIDES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

/** Opt-in marker: a repo is guarded only if this sits at its root. */
export const GUARD_MARKER = ".worktree-guard";
/** A worktree that exists only to fetch/pull and base new worktrees from. */
export const PULL_ONLY_MARKER = ".worktree-pull-only";

export interface GitLocation {
	/** `--git-common-dir`, absolute. */
	commonDir: string;
	/** `--git-dir`, absolute. Differs from commonDir inside a linked worktree. */
	gitDir: string;
	/** `--show-toplevel`. */
	topLevel: string;
}

export interface GuardProbe {
	/** Nearest ancestor of `path` that exists, or null. */
	existingDir(path: string): string | null;
	/**
	 * Resolve `path` through symlinks to where a write to it actually lands.
	 *
	 * Follows a symlinked LEAF (the edit target is itself a symlink) — the case
	 * `existingDir`/git miss, because the repo is located from the PARENT
	 * directory. Without this, a symlink in an allowed worktree pointing at a
	 * file in a protected one is judged by the (allowed) parent and slips
	 * through. This is the symlink-write-redirect class (both vendors patched
	 * Aug 1 / 2.1.210-222). Returns the input unchanged when nothing resolves.
	 */
	realPath(path: string): string;
	/** Git location for a directory, or null when it is not in a repo. */
	locate(dir: string): GitLocation | null;
	fileExists(path: string): boolean;
	/**
	 * Is `relPath` COMMITTED in the repo at `topLevel`?
	 *
	 * The one question that separates a disposable clone from the anchor. See
	 * `decide`'s main-worktree branch: a tracked marker travels with `git clone`
	 * and so cannot assert anything about a particular directory, while an
	 * untracked one exists only where somebody put it.
	 */
	isTracked(topLevel: string, relPath: string): boolean;
}

export type GuardVerdict =
	/** `note` is advisory: allowed either way, but with something worth saying. */
	| { kind: "allow"; note?: string }
	| { kind: "block"; reason: string };

const ALLOW: GuardVerdict = { kind: "allow" };

function remediation(root: string): string {
	return [
		"",
		"Create a task worktree instead, then retry the edit there:",
		"",
		"  gwq add -b <task-name>",
		"  cd $(gwq get <task-name>)",
		"",
		// The pathless form is right for an ordinary session and EROFS every
		// time in a sandbox, where gwq's configured basedir is the shared
		// worktree root — read-only there deliberately, because it holds every
		// other checkout on the machine including the operator's own.
		//
		// So an agent that read this line, ran it, and got "could not create
		// leading directories ... Read-only file system" had been handed the one
		// command it was not able to run. Three papercuts on 2026-08-18 are
		// exactly that, two of them blocking; hive's sandbox briefing was fixed
		// for it (HIV-2001) but this text is the one an agent reaches at the
		// moment it is stuck, and it kept pointing the other way.
		"If gwq answers 'Read-only file system', you are in a sandbox: its default",
		"basedir is the shared worktree root, which is outside your write grant. Name a",
		"destination you CAN write (your sandbox briefing gives the exact scratch path):",
		"",
		"  gwq add -b <task-name> <writable-dir>/<task-name>",
		"",
		`The equivalent file path in your new worktree replaces ${root}.`,
	].join("\n");
}

/**
 * Decide whether an edit is allowed.
 *
 * Fails OPEN on everything it cannot determine — no path, no directory, not a
 * git repo. That matches the script and is the right default for a guard whose
 * job is to catch a specific known-bad case: a guard that blocks when confused
 * makes the harness unusable in every directory it does not understand.
 *
 * It does NOT fail open on the cases it does understand. That is the whole
 * difference from the bridge it replaces.
 */
export function decide(filePath: string | undefined, toolLabel: string, probe: GuardProbe): GuardVerdict {
	if (!filePath) return ALLOW;

	// Canonicalize through symlinks FIRST, so the edit is judged by where the
	// bytes land rather than the lexical path the caller supplied. A symlinked
	// leaf that redirects into a protected worktree resolves to that worktree
	// here; an ordinary path is returned unchanged.
	const resolved = probe.realPath(filePath);
	// Surface a redirect so a block on a symlinked path is not baffling.
	const via = resolved !== filePath ? ` (via symlink → ${resolved})` : "";

	const dir = probe.existingDir(dirname(resolved));
	if (!dir) return ALLOW;

	const location = probe.locate(dir);
	if (!location) return ALLOW; // not in a repo

	// A LINKED worktree: git-dir points inside the common dir's `worktrees/`.
	if (location.commonDir !== location.gitDir) {
		// Pull-only worktrees are still blocked. They are the canonical fetch base
		// (and, for hive-pi, the stow source for the live harness config) — an
		// edit there is an uncommitted change to something other sessions read.
		if (location.topLevel && probe.fileExists(join(location.topLevel, PULL_ONLY_MARKER))) {
			const name = location.topLevel.split("/").filter(Boolean).pop() ?? location.topLevel;
			return {
				kind: "block",
				reason:
					`BLOCKED: ${name} is a PULL-ONLY worktree (${PULL_ONLY_MARKER} at ${location.topLevel}) — ` +
					`the canonical fetch/pull base, not for edits (${toolLabel} on ${filePath}${via}).\n` +
					remediation(location.topLevel),
			};
		}
		return ALLOW; // an ordinary task worktree — this is where work belongs
	}

	// The MAIN worktree. Guarded only if the repo opted in.
	if (!location.topLevel) return ALLOW;
	if (!probe.fileExists(join(location.topLevel, GUARD_MARKER))) return ALLOW;

	// A COMMITTED marker cannot mean "this directory is the anchor".
	//
	// `.worktree-guard` is tracked in Aurora, hive-pi and Borealis-Ops, so it
	// arrives with every `git clone` — and a clone is a MAIN worktree. The rule
	// above therefore fired on every disposable clone anyone made: a rebase
	// staging area under `/tmp`, a nested `.retarget-w4` recovery clone, a
	// sandbox's granted workspace. Four papercuts 2026-08-15..19, one blocking,
	// all of them the same sentence — "blocked as 'the main worktree'" for a
	// directory nobody would call canonical. One reporter put it exactly: it
	// "fires on ANY working tree found via the repo root, even a scratch clone
	// in /tmp".
	//
	// The repo already knows the right rule and applies it one branch up.
	// `.worktree-pull-only` is deliberately UNTRACKED — one line in
	// `info/exclude`, present only in the anchor — and its own comment says why:
	// "Committing it would put it in EVERY worktree and make every task worktree
	// pull-only, which locks the repo against all work." A tracked marker has the
	// same defect for the same reason; only the blast radius differs.
	//
	// So the marker's meaning is now conditional on how it got there. Untracked:
	// somebody put it in THIS directory, and it blocks. Tracked: it came with the
	// repo, and it cannot distinguish the anchor from a copy, so it advises.
	//
	// What this gives up, stated plainly: a plain `git clone` on a machine with no
	// worktree layout loses edit protection until its operator creates the marker
	// untracked. That is the case the tracked marker was kept for ("the fallback
	// for a non-bare clone" — .worktree-guard's own words). It was protecting
	// nothing here: every canonical checkout on this machine is a LINKED worktree
	// held by the pull-only branch above, so this branch has no true positives to
	// lose — measured 2026-08-19 across Aurora, hive, hive-pi and Borealis-Ops.
	const name = location.topLevel.split("/").filter(Boolean).pop() ?? location.topLevel;
	if (probe.isTracked(location.topLevel, GUARD_MARKER)) {
		return {
			kind: "allow",
			note:
				`${name} carries a COMMITTED ${GUARD_MARKER}, which every clone of the repo has, so it ` +
				`cannot mark this directory as the canonical checkout — treating it as an ordinary clone ` +
				`and allowing the edit. If this IS a canonical checkout that should be protected, create ` +
				`the marker untracked instead (add ${GUARD_MARKER} to .git/info/exclude), the way ` +
				`${PULL_ONLY_MARKER} is done.`,
		};
	}

	return {
		kind: "block",
		reason:
			`BLOCKED: ${name} is worktree-protected (${GUARD_MARKER} at ${location.topLevel}, untracked). ` +
			`Cannot modify files in the main worktree (${toolLabel} on ${filePath}${via}).\n` +
			remediation(location.topLevel),
	};
}

/**
 * The real probe.
 *
 * ONE `git rev-parse` for all three answers, where the script it replaces spawned
 * bash and then three separate git processes. This runs inside a `tool_call`
 * handler that pi awaits serially — a slow handler IS the agent loop — so the
 * saving is on the hot path of every edit, not a micro-optimisation.
 */
export const realProbe: GuardProbe = {
	existingDir(path: string): string | null {
		let current = path;
		// Walk up until something exists. A brand-new file's directory may not.
		while (current && current !== "/" && !existsSync(current)) current = dirname(current);
		if (!current || current === "" || !existsSync(current)) return null;
		// Resolve symlinks: a symlinked ANCESTOR directory pointing into a
		// protected worktree must be located there, not at its lexical path.
		try {
			return realpathSync(current);
		} catch {
			return current;
		}
	},

	realPath(path: string): string {
		// A symlinked LEAF is the redirect `existingDir` cannot see: it locates
		// the repo from the parent, which may be an ordinary allowed directory.
		// lstat (not exists) so a symlink is followed even when its target does
		// not exist yet — creating the target is the write we must catch.
		try {
			if (lstatSync(path).isSymbolicLink()) {
				const target = readlinkSync(path);
				const abs = isAbsolute(target) ? target : join(dirname(path), target);
				return this.realPath(abs); // resolve chains and symlinked parents
			}
		} catch {
			// Leaf does not exist — fall through to resolve the deepest existing
			// prefix, which collapses any symlinked parent directory.
		}
		let prefix = path;
		const tail: string[] = [];
		while (prefix && prefix !== "/" && !existsSync(prefix)) {
			tail.unshift(basename(prefix));
			prefix = dirname(prefix);
		}
		if (!prefix || !existsSync(prefix)) return path;
		try {
			const real = realpathSync(prefix);
			return tail.length ? join(real, ...tail) : real;
		} catch {
			return path;
		}
	},

	locate(dir: string): GitLocation | null {
		// Scrub the git env overrides so discovery is honest and cwd-based — an
		// inherited GIT_DIR wins over `-C <dir>` and would route the guard to a
		// different repo than the edit lands in.
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const key of GIT_ENV_OVERRIDES) delete env[key];
		const res = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir", "--git-dir", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 5_000,
			env,
		});
		if (res.error || res.status !== 0) return null;
		const [commonDir, gitDir, topLevel] = (res.stdout ?? "").trim().split("\n");
		if (!commonDir || !gitDir) return null;
		// git answers with paths relative to `dir` in the main worktree (".git")
		// and absolute ones in a linked worktree. Resolve both, or the string
		// comparison below decides "linked vs main" on formatting rather than fact.
		const resolve = (p: string) => (p.startsWith("/") ? p : join(dir, p));
		return { commonDir: resolve(commonDir), gitDir: resolve(gitDir), topLevel: (topLevel ?? "").trim() };
	},

	fileExists(path: string): boolean {
		return existsSync(path);
	},

	/**
	 * A second git call, on one path only: main worktree AND the marker present —
	 * which before this change was the path that always blocked, so nothing that
	 * used to be allowed pays for it. Edits in a task worktree, the overwhelming
	 * majority, return before reaching here.
	 *
	 * Env scrubbed for the same reason `locate` scrubs it: an inherited GIT_DIR
	 * beats `-C`, and answering "tracked" from a different repo would decide this
	 * verdict on the wrong index. Fails CLOSED — an error, a timeout or a
	 * non-repo answers "not tracked", which keeps the block. A guard that
	 * unblocks itself when git is unavailable is worse than a false positive.
	 */
	isTracked(topLevel: string, relPath: string): boolean {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const key of GIT_ENV_OVERRIDES) delete env[key];
		const res = spawnSync("git", ["-C", topLevel, "ls-files", "--error-unmatch", "--", relPath], {
			encoding: "utf8",
			timeout: 5_000,
			env,
		});
		return !res.error && res.status === 0;
	},
};
