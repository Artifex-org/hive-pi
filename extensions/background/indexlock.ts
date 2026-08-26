/**
 * What a killed job leaves behind in a git repo.
 *
 * `git` takes `.git/index.lock` for the duration of any command that writes the
 * index, and removes it on the way out. A killed git does not get to the way
 * out — so a cancel, or a timeout, or a SIGTERM to a process group leaves the
 * lock sitting there and the NEXT git command fails with
 *
 *	fatal: Unable to create '…/.git/index.lock': File exists
 *
 * which names a file, not a cause. Three papercuts on 2026-08-18 are that
 * sequence, one of them explicitly: "Cancelling bg-2 left
 * …/worktrees/feature-cbcf2900/index.lock, so the next job failed immediately".
 * Another session, an hour later, found the lock still there with no git
 * process holding it.
 *
 * This REPORTS; it never removes. A lock with a live holder is doing its job,
 * and an automatic delete would turn an annoying failure into a corrupted
 * index. Naming the path and the check is what turns a mystery into a
 * ten-second fix.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** How long the git-dir lookup may take. It is one rev-parse in a local repo. */
const GIT_DIR_TIMEOUT_MS = 2_000;

/**
 * The absolute git dir for `cwd`, or null when there is no repo (or git is not
 * installed, or it is slow — every failure is "no answer", never a throw: this
 * runs inside a cancel, and a cancel must not fail because a diagnostic did).
 */
export function gitDirOf(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
			cwd,
			timeout: GIT_DIR_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const dir = out.trim();
		return dir === "" ? null : dir;
	} catch {
		return null;
	}
}

/**
 * A line about a stranded index lock, or "" when there is nothing to say.
 *
 * Deliberately NOT conditional on the command looking git-ish. A pre-commit
 * hook, a repo gate, a test that shells out — plenty of jobs touch the index
 * without `git` appearing in what was typed, and the check costs one rev-parse.
 */
export function strandedIndexLock(
	cwd: string | undefined,
	deps: { gitDir?: (cwd: string) => string | null; exists?: (path: string) => boolean } = {},
): string {
	if (!cwd) return "";
	// The whole body is guarded, not just the git call. This runs inside a
	// cancel: a diagnostic that throws would turn "your job was cancelled" into
	// a failed tool call, which is a worse bug than the one it reports. (Its own
	// test caught this — the injected probe threw straight through.)
	try {
		return describeLock(cwd, deps);
	} catch {
		return "";
	}
}

function describeLock(
	cwd: string,
	deps: { gitDir?: (cwd: string) => string | null; exists?: (path: string) => boolean },
): string {
	const gitDir = (deps.gitDir ?? gitDirOf)(cwd);
	if (!gitDir) return "";
	const lock = join(gitDir, "index.lock");
	if (!(deps.exists ?? existsSync)(lock)) return "";
	return (
		`NOTE: \`${lock}\` exists. A killed git does not remove its lock, so the next git command here will ` +
		`fail with "Unable to create … index.lock: File exists".\n` +
		`If this job was the only git in that repo the lock is stranded: confirm no git is running ` +
		`(\`pgrep -fa "git "\`), then delete it. If something else IS running, leave it alone — the lock is real.`
	);
}
