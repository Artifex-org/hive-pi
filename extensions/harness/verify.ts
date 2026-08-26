/**
 * Mechanical verification of worker claims — the free tier.
 *
 * A writer-capable worker that exits 0 and says "done" while the working tree
 * is byte-identical to when it started has, mechanically, done nothing. That
 * is the "success-shaped nothing" class (an empty factory run reported green,
 * a `tasks_summary.total == 0` treated as success), and it is caught here with
 * two `git status` spawns rather than a model call.
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
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;

/** One git invocation's stdout, or null when it could not run. */
function gitOutput(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const finish = (value: string | null) => {
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
				out += d.toString();
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				finish(code === 0 ? out : null);
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

/**
 * A stamp of the working tree's mutation state: `git status --porcelain`
 * output (covers tracked modifications, staged changes and untracked files).
 * Returns null when the stamp cannot be taken — a missing git, a non-repo cwd
 * — and a null stamp DISABLES the check rather than failing the worker: a
 * verifier that could not run must never report as a verifier that ran and
 * failed (the gate's bashAvailable rule).
 */
export function diffStamp(cwd: string): Promise<string | null> {
	return gitOutput(cwd, ["status", "--porcelain"]);
}

/**
 * A CONTENT-AWARE stamp for gate-retry throttling: `git status --porcelain`
 * plus a hash of `git diff HEAD` (tracked content, staged and unstaged).
 *
 * `diffStamp` alone is the wrong key here, and the failure is subtle: it sees
 * paths and status codes only, so a model that edits an ALREADY-DIRTY file to
 * fix a red gate produces a byte-identical status — and a status-keyed skip
 * would then never re-run the gate on the very settle where the fix landed.
 * Hashing the diff content catches that; untracked-file content is left to the
 * status half (a new untracked file changes the status output).
 *
 * Same null discipline as `diffStamp`: a stamp that cannot be taken DISABLES
 * the skip rather than producing one.
 */
export async function gateStamp(cwd: string): Promise<string | null> {
	const [status, diff] = await Promise.all([
		gitOutput(cwd, ["status", "--porcelain"]),
		gitOutput(cwd, ["diff", "HEAD"]),
	]);
	if (status === null || diff === null) return null;
	return `${status}\n#diff:${createHash("sha256").update(diff).digest("hex")}`;
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
