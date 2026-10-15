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
import { killTree, trackTree, treeSpawnOptions, TREE_TOKEN } from "../hive-common/child-tree.ts";

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

export interface StampOptions {
	signal?: AbortSignal;
	/** Absolute wall deadline shared by all preparation subprocesses and stats. */
	deadline?: number;
}
function exhausted(options: StampOptions): boolean {
	return Boolean(options.signal?.aborted) || Date.now() >= (options.deadline ?? Infinity);
}

interface StreamDigest { write(data: string): void; finish(): string }

/** Scalar stdout or a streaming digest; null when the invocation could not run. */
function gitOutput(cwd: string, args: string[], options: StampOptions = {}, stream?: StreamDigest): Promise<string | null> {
	if (exhausted(options)) return Promise.resolve(null);
	return new Promise((resolve) => {
		let out = "", settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let terminate = () => {};
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", terminate);
			resolve(value);
		};
		try {
			const owned = treeSpawnOptions();
			const child = spawn("git", args, { ...owned, cwd, stdio: ["ignore", "pipe", "ignore"] });
			trackTree(child, Boolean(owned.detached), owned.env[TREE_TOKEN]);
			terminate = () => {
				if (settled) return;
				killTree(child, "SIGKILL", Boolean(owned.detached));
				child.stdout.destroy();
				child.unref();
				finish(null);
			};
			timer = setTimeout(terminate, Math.max(0, Math.min(GIT_TIMEOUT_MS, (options.deadline ?? Infinity) - Date.now())));
			options.signal?.addEventListener("abort", terminate, { once: true });
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (data: string) => {
				if (settled) return;
				try {
					if (exhausted(options)) return terminate();
					if (stream) stream.write(data);
					else { out += data; if (out.length > GIT_OUTPUT_LIMIT) terminate(); }
				} catch { terminate(); }
			});
			child.on("close", code => {
				try { finish(code === 0 && !exhausted(options) ? stream ? stream.finish() : out : null); }
				catch { finish(null); }
			});
			child.on("error", () => finish(null));
			if (options.signal?.aborted) terminate();
		} catch { finish(null); }
	});
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
 * Four parts, each closing a hole the measured false "writer produced no
 * working-tree change" fell through (papercuts 2026-10-02T03:38, 10-03T03:27):
 *
 *   1. `status --porcelain --untracked-files=all` — paths and codes, with every
 *      file inside an untracked directory listed individually. The default
 *      collapses a whole new directory to `?? dir/`, so a writer adding a file
 *      inside it changed nothing the stamp could see.
 *   2. a hash of `git diff-index -p HEAD` — tracked content, staged and unstaged. An edit
 *      to an ALREADY-modified file leaves the status line ` M a.ts` unchanged.
 *   3. committed tree identity — a writer that commits content still changed
 *      the input, but empty commits/amendments remain no-ops. Gates opt into
 *      HEAD commit identity to invalidate receipts on every new commit.
 *   4. size + mtime of every untracked, non-ignored file — an edit to an
 *      ALREADY-untracked file changes neither the status nor the diff. Metadata
 *      rather than content so a large untracked asset costs a stat, not a read.
 *
 * A stamp that cannot be taken is null, which DISABLES the check rather than
 * failing the worker: a verifier that could not run must never report as a
 * verifier that ran and failed (the gate's bashAvailable rule). That includes
 * a repo with no commit yet — `git diff HEAD` has nothing to diff against.
 */
export async function treeStamp(cwd: string, identity: "tree" | "commit" = "tree", options: StampOptions = {}): Promise<string | null> {
	if (exhausted(options)) return null;
	// Resolve the root before streaming untracked stats: porcelain paths are
	// root-relative even when the caller is in a subdirectory.
	const [root, head] = await Promise.all([
		gitOutput(cwd, [LOCK_FREE, "rev-parse", "--show-toplevel"], options),
		gitOutput(cwd, [LOCK_FREE, "rev-parse", identity === "commit" ? "HEAD" : "HEAD^{tree}"], options),
	]);
	if (root === null || head === null || exhausted(options)) return null;
	const diffHash = createHash("sha256");
	const [status, diff] = await Promise.all([
		gitOutput(cwd, [LOCK_FREE, "status", "--porcelain", "-z", "--untracked-files=all"], options, statusDigest(root.trim(), options)),
		// diff-index reads the index without refreshing/writing it.
		gitOutput(cwd, [LOCK_FREE, "diff-index", "-p", "HEAD"], options, { write: data => { diffHash.update(data); }, finish: () => diffHash.digest("hex") }),
	]);
	if (status === null || diff === null || exhausted(options)) return null;
	return createHash("sha256").update(head).update("\0").update(status).update("\0").update(diff).digest("hex");
}

/** Hash arbitrary-size status output, retaining only one NUL-delimited path. */
function statusDigest(root: string, options: StampOptions): StreamDigest {
	const listing = createHash("sha256"), metadata = createHash("sha256");
	let pending = "", renameSource = false;
	return {
		write(data) {
			listing.update(data); pending += data;
			let end: number;
			while ((end = pending.indexOf("\0")) !== -1) {
				if (exhausted(options)) throw new Error("Fingerprint deadline exhausted");
				const entry = pending.slice(0, end); pending = pending.slice(end + 1);
				if (renameSource) { renameSource = false; continue; }
				renameSource = /^[RC]|^.[RC]/.test(entry);
				if (!entry.startsWith("?? ")) continue;
				const rel = entry.slice(3); metadata.update(rel).update("\0");
				try {
					const stats = statSync(join(root, rel));
					metadata.update(`${stats.size} ${stats.mtimeMs}\0`);
				} catch { metadata.update("gone\0"); }
			}
			// Valid filesystem paths fit well below this; reject malformed output,
			// not a valid listing merely because its total size exceeds 32MiB.
			if (pending.length > 1024 * 1024) throw new Error("Invalid status record");
		},
		finish() {
			if (pending || renameSource) throw new Error("Incomplete status listing");
			return `${listing.digest("hex")}:${metadata.digest("hex")}`;
		},
	};
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
