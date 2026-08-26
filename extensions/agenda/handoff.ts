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
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalItem } from "./goal-state.ts";
import type { ConductorItem } from "./conductor-state.ts";
import type { SessionSignals } from "./signals.ts";

export const HANDOFF_FILE = "handoff.md";
const MAX_SEED_CHARS = 12_000;

export interface HandoffInput {
	/** The next session's objective — the user's argument, or a derived line. */
	objective: string;
	goal: GoalItem | null;
	conductor: ConductorItem | null;
	signals: SessionSignals;
	/** `git status --porcelain` of the worktree, or null when unavailable. */
	gitStatus: string | null;
	cwd: string;
}

/**
 * Build the seed prompt. Everything in it is state the next session cannot
 * see otherwise: the objective, the finish line, where the lifecycle stood,
 * open todos, and which files are mid-flight. Deliberately NOT a summary of
 * the conversation — that is what handoff exists to avoid re-compressing.
 */
export function buildHandoffSeed(input: HandoffInput): string {
	const lines: string[] = [
		"# Handoff from previous session",
		"",
		`Working directory: ${input.cwd}`,
		"",
		"## Objective",
		input.objective.trim() || "(carry the previous session's work forward — see below)",
	];

	if (input.goal && (input.goal.state === "active" || input.goal.state === "paused")) {
		lines.push("", "## Finish line (goal)", input.goal.condition);
	}
	if (input.conductor && input.conductor.stage !== "idle" && input.conductor.stage !== "done") {
		lines.push("", "## Lifecycle", `The previous session was in the "${input.conductor.stage}" stage.`);
	}

	const tasks = input.signals.tasks;
	if (tasks.total > 0) {
		lines.push(
			"",
			"## Todos",
			`${tasks.completed}/${tasks.total} completed, ${tasks.inProgress} in progress, ${tasks.pending} pending — re-derive the open ones from the plan/objective and capture them with TodoWrite.`,
		);
	}
	if (input.signals.plan.phase && input.signals.plan.stepCount > 0) {
		lines.push(
			"",
			"## Plan",
			`A plan exists (phase: ${input.signals.plan.phase}, ${input.signals.plan.stepCount} step(s)${
				input.signals.plan.goal ? `, goal: ${input.signals.plan.goal}` : ""
			}).`,
		);
	}
	if (input.gitStatus?.trim()) {
		lines.push("", "## Files mid-flight (`git status --porcelain`)", "```", input.gitStatus.trim(), "```");
	}

	lines.push(
		"",
		"---",
		"Start by verifying this seed against the worktree (git status, the plan file, recent commits) — it was written at handoff time and the user may have edited it.",
	);

	return lines.join("\n").slice(0, MAX_SEED_CHARS);
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
