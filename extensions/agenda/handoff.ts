/**
 * `/handoff` — a seeded new-session handoff instead of compaction (HIV-1231).
 *
 * Amp's measured position: repeated summarization distorts earlier reasoning,
 * so for phase-structured work a CLEAN BREAK beats lossy compression — end the
 * session at a phase boundary and seed the next one with a reviewable prompt.
 * This is the pi version: `/handoff [objective]` writes the seed to
 * `.pi/handoff.md`, the USER reviews/edits it (the file is the review UI —
 * no new overlay machinery), and the next fresh session in that cwd consumes
 * it exactly once via session-context's one-shot injection.
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalItem } from "./goal-state.ts";
import type { ConductorItem } from "./conductor-state.ts";
import type { SessionSignals } from "./signals.ts";
import type { PlanDoc, WorkItem } from "../plan/state.ts";
import type { RecapSection } from "./session-recap.ts";

export const HANDOFF_FILE = "handoff.md";
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

/** Where the seed lives for a cwd. */
export function handoffPath(cwd: string): string {
	return join(cwd, ".pi", HANDOFF_FILE);
}

/** Write the seed. Returns the path. Creates `.pi/` when missing. */
export function writeHandoff(cwd: string, seed: string): string {
	const dir = join(cwd, ".pi");
	mkdirSync(dir, { recursive: true });
	const path = handoffPath(cwd);
	writeFileSync(path, seed, "utf8");
	return path;
}

/**
 * Consume a pending handoff seed: read it, then RENAME it so it can never be
 * injected twice. Returns null when there is nothing to consume or the file
 * cannot be read — failing open (no injection) is the safe direction.
 */
export function consumeHandoff(cwd: string, now = Date.now()): string | null {
	const path = handoffPath(cwd);
	try {
		if (!existsSync(path)) return null;
		const seed = readFileSync(path, "utf8");
		if (!seed.trim()) return null;
		renameSync(path, join(cwd, ".pi", `handoff-consumed-${now}.md`));
		return seed;
	} catch {
		return null;
	}
}
