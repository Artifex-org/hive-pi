/**
 * `/handoff` — a seeded new-session handoff instead of compaction (HIV-1231).
 *
 * Amp's measured position: repeated summarization distorts earlier reasoning,
 * so for phase-structured work a CLEAN BREAK beats lossy compression — end the
 * session at a phase boundary and seed the next one with a reviewable prompt.
 * This is the pi version: `/handoff [objective]` writes the seed to the
 * per-worktree private git dir (`git rev-parse --git-dir`/handoff/handoff.md),
 * the USER reviews/edits it (the file is the review UI —
 * no new overlay machinery), and the next fresh session in that cwd consumes
 * it exactly once via session-context's one-shot injection.
 *
 * The git dir — NOT the common dir — is load-bearing: inside a linked
 * worktree `--git-dir` points at `<common>/.git/worktrees/<name>`, which is
 * outside the checkout, so the seed never appears in `git status`, snapshots
 * or commits. (In a Hive checkout `.pi/` is not ignored, which is exactly how
 * the old `.pi/handoff.md` location contaminated them.) A cwd outside any git
 * repo falls back to the legacy `.pi/handoff.md`, and a pending legacy seed is
 * still consumed once — but the consumed rename always lands beside the
 * pending seed's successor location, never as a new file in the checkout.
 *
 * Consumption guards (both load-bearing):
 *   - workers never consume (PI_AGENDA_WORKER, checked by the caller) — every
 *     `pi -p` child reports `reason:"startup"`;
 *   - interactive modes only (tui/rpc, checked by the caller) — a stray
 *     scripted `pi -p` in the same cwd must not silently eat the seed.
 *
 * Compaction stays as the fallback for unplanned overflow; handoff is the
 * deliberate tool. The consumed file is RENAMED, not deleted — lineage stays
 * on disk next to the sessions it links.
 *
 * ## Two sources, because they hold different halves
 *
 * The seed is assembled from LOCAL state and REMOTE state, and neither can
 * stand in for the other:
 *
 *   - **Local** — the open work items. Hive stores the plan as an opaque jsonb
 *     document and parses only `{phase, done, total}` out of it, and it stores
 *     no todos at all (a todo IS a lane item since HIV-2904). The step text
 *     exists only on this machine, so the seed reads it here.
 *   - **Remote** (`recap_session`) — branch, PR, CI verdict, claimed tickets,
 *     knowledge already read, teammates. None of it is derivable from the
 *     worktree, and re-deriving the knowledge half means re-running searches
 *     the previous session already paid for.
 *
 * Still deliberately NOT a summary of the conversation. Re-compressing prose
 * is the thing handoff exists to avoid; every block below is a FACT the
 * successor could not otherwise cheaply obtain.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GoalItem } from "./goal-state.ts";
import type { ConductorItem } from "./conductor-state.ts";
import type { SessionSignals } from "./signals.ts";
import type { PlanDoc, WorkItem } from "../plan/state.ts";
import type { RecapSection } from "./session-recap.ts";

export const HANDOFF_FILE = "handoff.md";
/** Subdirectory of the git dir holding pending and consumed seeds. */
const HANDOFF_DIR = "handoff";
/**
 * Git env vars that override cwd-based repo discovery (`git -C <dir>` does
 * NOT win over an inherited GIT_DIR). Scrubbed before `rev-parse` for the
 * same reason guards-common/worktree-guard.ts scrubs them: discovery must be
 * honest and cwd-based, and this function must never reroute a seed on the
 * strength of an inherited variable. Read-only use — nothing here writes
 * machine config.
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
const MAX_SEED_CHARS = 12_000;
/** A worktree mid-rebase can carry hundreds of paths; the seed is not a diff. */
const MAX_GIT_STATUS_LINES = 40;
/** Open items are the point of the seed, but a 200-item plan is still a plan. */
const MAX_OPEN_ITEMS = 40;

export interface HandoffInput {
	/** The next session's objective — the user's argument, or a derived line. */
	objective: string;
	goal: GoalItem | null;
	conductor: ConductorItem | null;
	signals: SessionSignals;
	/** `git status --porcelain` of the worktree, or null when unavailable. */
	gitStatus: string | null;
	cwd: string;
	/**
	 * The live plan document, for the OPEN work items. Null when this session
	 * never wrote a plan — which is a fact about it, not a failure.
	 */
	plan?: PlanDoc | null;
	/**
	 * Sections folded out of `recap_session`, or null when Hive was not
	 * reachable. Null and `[]` mean different things and the seed says which.
	 */
	recap?: RecapSection[] | null;
}

/** A block of the seed plus how readily the successor could rebuild it itself. */
interface SeedSection {
	lines: string[];
	/**
	 * Drop order under the character budget: HIGHER numbers go first.
	 * Ranked by how cheaply the successor can re-derive the block —
	 * teammates and knowledge are one tool call away, the open work is not.
	 */
	dropRank: number;
}

/** Statuses that mean "still owed". `blocked` counts: it is unfinished work. */
function isOpen(item: WorkItem): boolean {
	return item.status === "pending" || item.status === "in_progress" || item.status === "blocked";
}

/**
 * The open work items, grouped by lane.
 *
 * Items whose `kind` Hive resolves (`push`, `pr.open`, `ci.green`, `merged` …)
 * are excluded, exactly as `tasksSignalOf` excludes them: a delivery lane's
 * pending observations are not work the successor owes, and listing them as
 * todos is how a fresh session starts by trying to "do" a CI result.
 */
export function openWorkLines(plan: PlanDoc | null | undefined): string[] {
	if (!plan || !Array.isArray(plan.blocks)) return [];
	const lines: string[] = [];
	let listed = 0;
	let elided = 0;
	for (const block of plan.blocks) {
		if (block.type !== "steps") continue;
		const open = block.steps.filter(
			(item) => (item.kind === undefined || item.kind === "task") && isOpen(item),
		);
		if (open.length === 0) continue;
		const laneLines: string[] = [];
		for (const item of open) {
			if (listed >= MAX_OPEN_ITEMS) {
				elided++;
				continue;
			}
			listed++;
			const mark = item.status === "in_progress" ? "~" : item.status === "blocked" ? "!" : " ";
			const title = item.title.trim() || item.id;
			const note = item.note?.trim();
			laneLines.push(`- [${mark}] ${title}${note ? ` — note: ${note}` : ""}`);
		}
		if (laneLines.length === 0) continue;
		const heading = block.title?.trim() || block.kind?.trim() || "Lane";
		lines.push(`**${heading}**`, ...laneLines, "");
	}
	if (elided > 0) lines.push(`(${elided} further open item(s) not listed — read the plan document.)`);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Bound `git status --porcelain` so a mid-rebase tree cannot eat the budget.
 *
 * Trailing-only trim, deliberately: porcelain's first two columns are the
 * status code and a leading space is significant — `" M"` (modified, unstaged)
 * and `"M "` (staged) differ only there. A whole-blob `.trim()` silently
 * rewrites the FIRST line's code into the other one.
 */
function gitStatusLines(gitStatus: string | null): string[] {
	const raw = gitStatus?.replace(/\s+$/, "");
	if (!raw || !raw.trim()) return [];
	const all = raw.split("\n");
	const shown = all.slice(0, MAX_GIT_STATUS_LINES);
	const lines = ["```", ...shown];
	if (all.length > shown.length) lines.push(`… ${all.length - shown.length} more path(s)`);
	lines.push("```");
	return lines;
}

/**
 * Build the seed prompt. Everything in it is state the next session cannot
 * see otherwise: the objective, the finish line, where the lifecycle stood,
 * the OPEN work items, the delivery/ticket/knowledge facts, and which files
 * are mid-flight. Deliberately NOT a summary of the conversation — that is
 * what handoff exists to avoid re-compressing.
 *
 * Over budget, whole blocks are dropped worst-first and the seed says which.
 * Truncating mid-block would leave a half-list that reads as a complete one.
 */
export function buildHandoffSeed(input: HandoffInput): string {
	const head: string[] = [
		"# Handoff from previous session",
		"",
		`Working directory: ${input.cwd}`,
		"",
		"## Objective",
		input.objective.trim() || "(carry the previous session's work forward — see below)",
	];

	if (input.goal && (input.goal.state === "active" || input.goal.state === "paused")) {
		head.push("", "## Finish line (goal)", input.goal.condition);
	}
	if (input.conductor && input.conductor.stage !== "idle" && input.conductor.stage !== "done") {
		head.push("", "## Lifecycle", `The previous session was in the "${input.conductor.stage}" stage.`);
	}

	const sections: SeedSection[] = [];

	// Open work — the block the successor genuinely cannot rebuild. Falls back
	// to the counts when no plan document exists, which is the pre-HIV-1231
	// behaviour and still better than silence.
	const openWork = openWorkLines(input.plan);
	if (openWork.length > 0) {
		const tasks = input.signals.tasks;
		const header =
			tasks.total > 0
				? `## Open work (${tasks.completed}/${tasks.total} done)`
				: "## Open work";
		sections.push({ lines: [header, ...openWork], dropRank: 1 });
	} else if (input.signals.tasks.total > 0) {
		const tasks = input.signals.tasks;
		sections.push({
			lines: [
				"## Open work",
				`${tasks.completed}/${tasks.total} completed, ${tasks.inProgress} in progress, ${tasks.pending} pending — the plan document did not survive to the seed; re-derive the open ones and capture them in the plan.`,
			],
			dropRank: 1,
		});
	}
	if (input.signals.plan.phase && input.signals.plan.stepCount > 0) {
		sections.push({
			lines: [
				"## Plan",
				`A plan exists (phase: ${input.signals.plan.phase}, ${input.signals.plan.stepCount} step(s)${
					input.signals.plan.goal ? `, goal: ${input.signals.plan.goal}` : ""
				}).`,
			],
			dropRank: 2,
		});
	}

	// Remote blocks, in the order handoffRecapSections emits them (delivery,
	// tickets, knowledge, team) — which is already worst-to-drop-last order.
	if (input.recap === null || input.recap === undefined) {
		sections.push({
			lines: [
				"## Hive state",
				"Unavailable at handoff time — this session was not attached to Hive, or Hive could not be reached. The block is ABSENT, not empty: call `recap_session` yourself before assuming there is no PR, ticket or teammate.",
			],
			dropRank: 3,
		});
	} else if (input.recap.length === 0) {
		sections.push({
			lines: [
				"## Hive state",
				"Hive was reachable and reported no branch, PR, ticket, knowledge or teammate for this session.",
			],
			dropRank: 3,
		});
	} else {
		let rank = 3;
		for (const section of input.recap) {
			rank++;
			sections.push({ lines: [`## ${section.label}`, ...section.lines], dropRank: rank });
		}
	}

	const git = gitStatusLines(input.gitStatus);
	if (git.length > 0) {
		sections.push({ lines: ["## Files mid-flight (`git status --porcelain`)", ...git], dropRank: 3 });
	}

	const footer = [
		"---",
		"Start by verifying this seed against the worktree (git status, the plan document, recent commits) — it was written at handoff time and the user may have edited it.",
	];

	return assemble(head, sections, footer);
}

/**
 * Join head + sections + footer within the budget, dropping whole sections
 * worst-first and recording that a drop happened.
 *
 * The head and footer are never dropped: a seed without its objective is not
 * a smaller seed, it is a different and useless one.
 */
function assemble(head: string[], sections: SeedSection[], footer: string[]): string {
	const order = sections.map((_, index) => index);
	// Stable worst-first: higher dropRank goes first, ties break on later position.
	order.sort((a, b) => sections[b].dropRank - sections[a].dropRank || b - a);

	const dropped = new Set<number>();
	const render = (): string => {
		const kept = sections.filter((_, index) => !dropped.has(index));
		const body = kept.flatMap((section) => ["", ...section.lines]);
		const notice =
			dropped.size > 0
				? ["", `_${dropped.size} further block(s) did not fit this seed's budget; re-read them from Hive and the plan document._`]
				: [];
		return [...head, ...body, ...notice, "", ...footer].join("\n");
	};

	let out = render();
	for (const index of order) {
		if (out.length <= MAX_SEED_CHARS) break;
		dropped.add(index);
		out = render();
	}
	// Every droppable block is gone and it still does not fit: the head alone is
	// over budget. Cut it rather than write a file nothing will read.
	return out.length <= MAX_SEED_CHARS ? out : out.slice(0, MAX_SEED_CHARS);
}

/** How git-dir discovery ended.
 *
 * `ok:true` with a null gitDir is a TRUE non-git cwd (git itself said "not a
 * git repository") — the only case that falls back to the legacy checkout
 * path. `ok:false` is a discovery FAILURE (no git on PATH, timeout, an
 * unexpected git error): the cwd may be a real repo whose status must not be
 * contaminated, so writers fail closed instead of falling back.
 */
export type GitDirDiscovery = { ok: true; gitDir: string | null } | { ok: false; detail: string };

const GIT_DISCOVERY_TIMEOUT_MS = 5_000;

/** Discriminated git-dir discovery: true non-git vs failure. Read-only — this
 * runs `rev-parse` and writes nothing to the machine config. */
export function discoverGitDir(cwd: string): GitDirDiscovery {
	// Scrubbed so discovery is honest and cwd-based: an inherited GIT_DIR wins
	// over `-C <dir>` and would route the seed into a different repo than the
	// session's checkout (same class guards-common/worktree-guard.ts scrubs for).
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of GIT_ENV_OVERRIDES) delete env[key];
	let res: SpawnSyncReturns<string>;
	try {
		res = spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
			encoding: "utf8",
			timeout: GIT_DISCOVERY_TIMEOUT_MS,
			env,
		});
	} catch (err) {
		return { ok: false, detail: `could not spawn git: ${String(err)}` };
	}
	if (res.error) {
		const code = (res.error as NodeJS.ErrnoException)?.code;
		if (code === "ETIMEDOUT") {
			return {
				ok: false,
				detail: `git rev-parse timed out after ${GIT_DISCOVERY_TIMEOUT_MS}ms in ${cwd}`,
			};
		}
		return { ok: false, detail: `could not run git rev-parse in ${cwd}: ${res.error.message}` };
	}
	if (res.status === 0) {
		const out = (res.stdout ?? "").trim().split("\n")[0]?.trim();
		if (!out) return { ok: false, detail: "git rev-parse --git-dir exited 0 but printed nothing" };
		// git answers relative (".git") in a main worktree, absolute in a linked
		// one — resolve both, or the seed lands on formatting rather than fact.
		return { ok: true, gitDir: isAbsolute(out) ? out : resolve(cwd, out) };
	}
	const stderr = (res.stderr ?? "").trim().split("\n")[0]?.trim() ?? "";
	// Exit 128 with "not a git repository" is the ONLY answer that means "not a
	// repo". Every other failure (dubious ownership, corrupt gitfile, a wrapper
	// on PATH) means the cwd may be a real repo — falling back to `.pi` there
	// would write checkout litter, so it fails closed instead.
	if (/not a git repository/i.test(stderr)) return { ok: true, gitDir: null };
	return {
		ok: false,
		detail: stderr ? `git rev-parse failed: ${stderr}` : `git rev-parse exited with status ${res.status}`,
	};
}

/** Where the seed lives for a cwd.
 *
 * The per-worktree private git dir (`git rev-parse --git-dir`, never the
 * common dir), so the seed is outside the checkout: no `git status` noise, no
 * snapshot/commit surface. Read-path compat only: on discovery FAILURE this
 * falls back to the legacy checkout path, so WRITERS must use `writeHandoff` /
 * `consumeHandoff` (which fail closed) rather than writing here.
 */
export function gitDirFor(cwd: string): string | null {
	const discovery = discoverGitDir(cwd);
	return discovery.ok ? discovery.gitDir : null;
}

/** The pre-git-dir location, kept as the non-git fallback and the compat read. */
export function legacyHandoffPath(cwd: string): string {
	return join(cwd, ".pi", HANDOFF_FILE);
}

export function handoffPath(cwd: string): string {
	const gitDir = gitDirFor(cwd);
	if (gitDir) return join(gitDir, HANDOFF_DIR, HANDOFF_FILE);
	return legacyHandoffPath(cwd);
}

/** Write the seed. Returns the path. Creates the parent dir when missing.
 *
 * Fail-closed: when git-dir discovery FAILS (as opposed to a true non-git
 * cwd) this throws instead of falling back to `.pi` — inside a real repo that
 * fallback would contaminate `git status` and snapshots. Both `/handoff`
 * callers already degrade safely (`performHandoff` returns the error for the
 * operator; the threshold path keeps the compaction fallback).
 */
export function writeHandoff(cwd: string, seed: string): string {
	const discovery = discoverGitDir(cwd);
	if (!discovery.ok) {
		throw new Error(
			`refusing to write handoff seed: git discovery failed (${discovery.detail}). ` +
				`Falling back to the checkout would contaminate git status and snapshots, so no seed was written. ` +
				`Check that git is on PATH and ${cwd} is readable, then retry — outside any repo the legacy .pi fallback applies.`,
		);
	}
	const path = discovery.gitDir ? join(discovery.gitDir, HANDOFF_DIR, HANDOFF_FILE) : legacyHandoffPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, seed, "utf8");
	return path;
}

/** Move a pending seed to its consumed name, crossing filesystems when needed.
 *
 * `renameSync` throws EXDEV when the checkout and the git dir live on
 * different filesystems (a `--separate-git-dir` repo, a gitdir pointer
 * elsewhere): the fallback copies then unlinks, preserving consume-once. When
 * anything else fails — or the copy succeeds but the unlink does not — this
 * returns false with NO duplicate left behind: a copied-but-not-unlinked seed
 * is removed again, so two pending seeds can never exist.
 */
function moveConsumedSeed(src: string, dest: string): boolean {
	try {
		renameSync(src, dest);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") return false;
	}
	try {
		copyFileSync(src, dest);
	} catch {
		return false;
	}
	try {
		unlinkSync(src);
	} catch {
		try {
			unlinkSync(dest);
		} catch {
			/* best-effort rollback: the next consume simply finds the pending seed */
		}
		return false;
	}
	return true;
}

/**
 * Consume a pending handoff seed: read it, then RENAME it so it can never be
 * injected twice. Returns null when there is nothing to consume or the file
 * cannot be read — failing open (no injection) is the safe direction.
 *
 * A pre-fix `.pi/handoff.md` still pending is honored once (newest pending
 * seed wins and a stale twin is removed so it can never inject later), and the
 * consumed rename always lands in the git-dir handoff dir when there is one —
 * consuming a legacy seed must not itself leave a file in the checkout.
 */
export function consumeHandoff(cwd: string, now = Date.now()): string | null {
	const discovery = discoverGitDir(cwd);
	// Discovery failure fails closed with NO writes and NO injection: without a
	// trustworthy primary location a legacy rename would land a consumed file in
	// the checkout, and returning the seed without moving it would inject it on
	// every future session. The seed stays pending for a session whose git works.
	if (!discovery.ok) return null;
	const primary = discovery.gitDir ? join(discovery.gitDir, HANDOFF_DIR, HANDOFF_FILE) : legacyHandoffPath(cwd);
	const legacy = legacyHandoffPath(cwd);
	const candidates = primary === legacy ? [primary] : [primary, legacy];
	let best: { path: string; seed: string; mtime: number } | null = null;
	for (const path of candidates) {
		try {
			if (!existsSync(path)) continue;
			const seed = readFileSync(path, "utf8");
			if (!seed.trim()) continue;
			let mtime = 0;
			try {
				mtime = statSync(path).mtimeMs;
			} catch {
				/* undated seed still counts, just never outranks a dated one */
			}
			if (!best || mtime > best.mtime) best = { path, seed, mtime };
		} catch {
			/* unreadable candidate degrades to the other one, not to a failure */
		}
	}
	if (!best) return null;
	try {
		mkdirSync(dirname(primary), { recursive: true });
	} catch {
		return null;
	}
	if (!moveConsumedSeed(best.path, join(dirname(primary), `handoff-consumed-${now}.md`))) return null;
	for (const path of candidates) {
		if (path === best.path) continue;
		try {
			unlinkSync(path);
		} catch {
			/* best-effort: the next consume simply finds nothing there */
		}
	}
	return best.seed;
}

/**
 * Should this compaction be replaced by a clean break?
 *
 * Pure and exported so the SAFETY argument is testable without a pi session.
 * Everything this returns false for is a case where cancelling would make the
 * session worse than compacting, and each has a different reason:
 *
 *  - **`overflow`** — the session is ALREADY past the provider's hard limit.
 *    Every further request is refused and each refusal leaves the context
 *    larger than the last (HIV-3060, measured: 15.5 hours burned across seven
 *    sessions, one issuing eleven identical 400s over 12h27m). Compaction is
 *    the only thing that can still rescue it, so this must never take that
 *    away. This is the single most important `false` in the function.
 *  - **`manual`** — the operator asked for a compaction. Answering a direct
 *    instruction with a different action is not a safety improvement.
 *  - **worker** — a `pi -p` child has no next session in its cwd to consume a
 *    seed, and its parent chose its context deliberately.
 *  - **not enabled** — see the flag's note at the call site: ending a session
 *    that still holds work needs a successor, and nothing yet starts one for
 *    context exhaustion the way `startQuotaSuccessor` does for quota.
 *
 * `threshold` is the ONLY case this exists for, and it is the only one
 * measured in practice: across 87 transcripts in three days, all 168
 * compactions carried `fromHook: false` — pi's own automatic path — with a
 * median `tokensBefore` of 207k.
 */
export function shouldHandoffInsteadOfCompact(input: {
	reason: "manual" | "threshold" | "overflow";
	isWorker: boolean;
	enabled: boolean;
}): boolean {
	if (input.isWorker) return false;
	if (!input.enabled) return false;
	return input.reason === "threshold";
}
