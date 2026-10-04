import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The global flag every harness-initiated git READ carries.
 *
 * `git status` and `git diff [HEAD]` are not pure reads. When a tracked file's
 * stat data no longer matches the index (a `touch`, a checkout, an editor that
 * rewrites in place), both refresh the index and opportunistically WRITE it
 * back — which means taking `.git/index.lock` for the duration. The harness runs
 * these in the background (the gate's dirty count, filerank's ranking signal,
 * hive-remote's worktree panel, the readiness probe, the held-out scan) while
 * the agent's own `git add` / `git commit` runs in the foreground, and the
 * agent's command then dies with
 *
 *	fatal: Unable to create '…/index.lock': File exists
 *
 * with no git process left to see by the time anyone looks. That was 17
 * papercuts of "index.lock exists … immediately afterward stat shows no lock".
 *
 * Reproduced 2026-10-04 in a 3000-file repo: a loop of `git status --porcelain`
 * beside 150 `git commit`s made 24 commits fail on index.lock; the same loop
 * with `--no-optional-locks` made none fail. git documents the flag for exactly
 * this case (git(1), GIT_OPTIONAL_LOCKS): a background reader that must not
 * contend with the user's own commands. The refresh still happens in memory,
 * so the output is unchanged; only the write-back is skipped.
 *
 * The lock is also how a lock gets STRANDED. git removes it on SIGTERM, SIGINT
 * and SIGHUP, but nothing can on SIGKILL: killing `git status` mid-refresh with
 * -9 left a stale 0-byte index.lock 20 times out of 20 in the same repro (0/20
 * with SIGTERM, 0/20 with this flag under -9). filerank starts one of these at
 * extension LOAD, so any process that loads the extensions and is then killed
 * hard — a pi session reaped with -9, a test worker torn down — could leave one.
 * With the flag the read never takes the lock, so no exit path can strand it.
 *
 * Prepended as a GLOBAL option (before the subcommand), which is the only
 * position git accepts it in.
 *
 * It covers `status` and NOT porcelain `diff`: measured on git 2.55, `git
 * --no-optional-locks diff HEAD` still rewrites a stat-dirty index. So a
 * working-tree diff the harness takes in the background is spelled with the
 * plumbing `git diff-index -p <commit>` instead — same patch, no index refresh
 * at all (and no user diff config such as `diff.external` in the way of a
 * parser). test/git-no-optional-locks.test.ts holds both halves.
 */
export const GIT_NO_OPTIONAL_LOCKS = "--no-optional-locks";

/**
 * The nearest enclosing git checkout of `cwd`, or null outside any.
 *
 * `.git` may be a directory (a clone) or a FILE (a linked worktree, which every
 * `hive worktrees create` checkout is); `existsSync` accepts both. A filesystem
 * walk rather than `git rev-parse` because its callers sit on paths that must
 * not spend a subprocess to answer a yes/no.
 */
export function repoRoot(cwd: string): string | null {
	let dir = cwd;
	for (let i = 0; i < 64; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
