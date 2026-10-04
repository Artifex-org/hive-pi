/**
 * Mechanical verification of worker claims — the free tier.
 *
 * A writer-capable worker that exits 0 and says "done" while the working tree
 * is byte-identical to when it started has, mechanically, done nothing. That
 * is the "success-shaped nothing" class (an empty factory run reported green,
 * a `tasks_summary.total == 0` treated as success), and it is caught here with
 * a before/after `treeStamp` (a few git spawns) rather than a model call.
 *
 * The comparison is before/after, never "is the diff empty": a worktree is
 * routinely dirty before the worker starts, and grading absolute cleanliness
 * would fail every worker that ran after a human's half-finished edit.
 *
 * Shared by `agenda/worker.ts` and the `subagent` tool — one implementation,
 * per the writer.ts consolidation rule (HIV-1132).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;

/**
 * One git invocation's raw stdout, or null when it could not run.
 *
 * Collected as Buffers and never decoded chunk by chunk: a chunk boundary can
 * split a multi-byte character, and bytes that are not UTF-8 at all (a Latin-1
 * file name) decode to U+FFFD — a path that then cannot be stat'ed, and two
 * different bytes that stamp the same (review S6).
 */
function gitBytes(cwd: string, args: string[]): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (value: Buffer | null) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish(null);
			}, GIT_TIMEOUT_MS);
			child.stdout.on("data", (d: Buffer) => {
				chunks.push(d);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				finish(code === 0 ? Buffer.concat(chunks) : null);
			});
			child.on("error", () => {
				clearTimeout(timer);
				finish(null);
			});
		} catch {
			finish(null);
		}
	});
}

/** One git invocation's stdout as text (decoded once, whole), or null. */
async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
	return (await gitBytes(cwd, args))?.toString("utf8") ?? null;
}

/**
 * Every git call here is lock-free, and must stay so: `gitOutput` SIGKILLs a
 * call that overruns its timeout, and a `git status` killed mid-refresh leaves
 * a stale `index.lock` that fails the agent's next `git add`/`commit` (20 of 20
 * reproductions). `--no-optional-locks` stops status writing the index; the
 * tracked diff is `diff-index`, because `git diff HEAD` writes it regardless.
 * Inlined rather than imported: the shared constant in hive-common/git.ts
 * arrives with a separate PR.
 */
const LOCK_FREE = "--no-optional-locks";

/**
 * The working tree's `git status --porcelain`, as TEXT for a reader — the
 * handoff seed and the verifier's task print it.
 *
 * NOT a change detector: it names paths and status codes only, so an edit to
 * an already-modified or already-untracked file leaves it byte-identical. The
 * writer guard and the gate throttle use `treeStamp`. Null when git cannot run
 * here (missing git, non-repo cwd).
 */
export function diffStamp(cwd: string): Promise<string | null> {
	return gitOutput(cwd, [LOCK_FREE, "status", "--porcelain"]);
}

/**
 * A CONTENT-AWARE stamp of the working tree — the one change detector, shared
 * by the writer guard ("did this writer change anything?") and the gate-retry
 * throttle ("has anything changed since the red gate?").
 *
 * Three parts, each closing a hole the measured false "writer produced no
 * working-tree change" fell through (papercuts 2026-10-02T03:38, 10-03T03:27):
 *
 *   1. `status --porcelain --untracked-files=all` — paths and codes, with every
 *      file inside an untracked directory listed individually. The default
 *      collapses a whole new directory to `?? dir/`, so a writer adding a file
 *      inside it changed nothing the stamp could see.
 *   2. a hash of `git diff-index -p HEAD` — tracked content, staged and unstaged. An edit
 *      to an ALREADY-modified file leaves the status line ` M a.ts` unchanged.
 *   3. size + mtime of every untracked, non-ignored file — an edit to an
 *      ALREADY-untracked file changes neither the status nor the diff. Metadata
 *      rather than content so a large untracked asset costs a stat, not a read.
 *
 * A stamp that cannot be taken is null, which DISABLES the check rather than
 * failing the worker: a verifier that could not run must never report as a
 * verifier that ran and failed (the gate's bashAvailable rule). That includes
 * a repo with no commit yet — `git diff HEAD` has nothing to diff against.
 */
export async function treeStamp(cwd: string): Promise<string | null> {
	const [status, diff, root] = await Promise.all([
		gitBytes(cwd, [LOCK_FREE, "status", "--porcelain", "-z", "--untracked-files=all"]),
		// `diff-index`, never `diff HEAD`: the latter rewrites a stat-dirty
		// index even under --no-optional-locks. diff-index reads the index and
		// the working tree and writes nothing (a stat-only change patches empty).
		gitBytes(cwd, [LOCK_FREE, "diff-index", "-p", "HEAD"]),
		// Porcelain paths are relative to the repo ROOT, not to cwd. Kept as
		// bytes: a root that is not UTF-8 must still join to statable paths.
		gitBytes(cwd, [LOCK_FREE, "rev-parse", "--show-toplevel"]),
	]);
	if (status === null || diff === null || root === null) return null;
	const untracked = untrackedFingerprint(trimNewline(root), status);
	const hash = createHash("sha256").update(status).update("\0").update(diff).update("\0").update(untracked).digest("hex");
	return `#tree:${hash}`;
}

/**
 * `path size mtime` for each `??` entry of a `-z` porcelain listing, worked
 * on as BYTES end to end so a path that is not UTF-8 is stat'ed as itself. A
 * file that vanished between the listing and the stat is recorded as gone —
 * that is itself a change.
 */
function untrackedFingerprint(root: Buffer, porcelainZ: Buffer): Buffer {
	const lines: Buffer[] = [];
	const slash = Buffer.from("/");
	let start = 0;
	while (start < porcelainZ.length) {
		let end = porcelainZ.indexOf(0, start);
		if (end === -1) end = porcelainZ.length;
		const entry = porcelainZ.subarray(start, end);
		start = end + 1;
		if (entry.length < 4 || entry[0] !== 0x3f || entry[1] !== 0x3f) continue; // "??"
		const rel = entry.subarray(3);
		let stamp: string;
		try {
			const stats = statSync(Buffer.concat([root, slash, rel]));
			stamp = ` ${stats.size} ${stats.mtimeMs}`;
		} catch {
			stamp = " gone";
		}
		lines.push(rel, Buffer.from(`${stamp}\n`));
	}
	return Buffer.concat(lines);
}

function trimNewline(bytes: Buffer): Buffer {
	let end = bytes.length;
	while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
	return bytes.subarray(0, end);
}

export const NO_CHANGE_ERROR =
	"writer produced no working-tree change; treat its success claim as unverified";

/**
 * Did a writer's run actually mutate the tree? Pure over the two stamps.
 * Either stamp being null means the check could not run → pass.
 */
export function writerMadeNoChange(before: string | null, after: string | null): boolean {
	if (before === null || after === null) return false;
	return before === after;
}

/**
 * File paths a summary cites (`path/to/file.ts:12`, `src/foo.py`), resolved
 * against the worker's cwd, that do not exist. A reader that invented its
 * evidence cites paths that are not there; listing them beside the summary is
 * the cheapest possible lie detector. Capped so a pathological summary cannot
 * turn this into a filesystem sweep.
 */
export function missingCitedPaths(text: string, cwd: string, cap = 20): string[] {
	const pattern = /(?:^|[\s(`])((?:\/|[\w.-]+\/)[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|yaml|yml|toml|star))(?=[\s:,)`]|$)/gm;
	const seen = new Set<string>();
	const missing: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null && seen.size < cap) {
		const cited = match[1];
		if (seen.has(cited)) continue;
		seen.add(cited);
		const resolved = isAbsolute(cited) ? cited : join(cwd, cited);
		try {
			if (!existsSync(resolved)) missing.push(cited);
		} catch {
			/* unreadable path — not evidence of fabrication */
		}
	}
	return missing;
}

/** Footer appended to cited-path offenders. Exported so tests pin the wording. */
export function citationWarning(missing: string[]): string {
	return `⚠ ${missing.length} cited path(s) do not exist in the worktree: ${missing.join(", ")} — verify before relying on claims about them.`;
}

/** The "claims, not evidence" footer on successful delegations. */
export const VERIFY_FOOTER =
	"— Subagent summaries are claims, not evidence: spot-check anything load-bearing (read the diff, run the check) before building on it.";
