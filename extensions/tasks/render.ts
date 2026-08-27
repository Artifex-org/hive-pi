/**
 * Rendering — pure, so the wording is testable without a TUI.
 *
 * Two audiences with different needs from the same state:
 *
 *   - `summaryLine` is the human's ambient glance, one row above the editor.
 *     It returns `undefined` for an empty list rather than an empty row: the
 *     footer already establishes that a surface with nothing to say costs no
 *     row, and a permanent `☐ 0 · ⧗ 0 · ☑ 0` is pure noise.
 *   - `renderList` is what the MODEL reads. It is the whole visibility
 *     mechanism for a list stored where the LLM structurally cannot see it, so
 *     it must be complete: every id, every status, every blocker.
 */

import { counts, danglingBlockers, type TaskItem, type TaskListState } from "./state.ts";

const GLYPHS = {
	pending: "☐",
	in_progress: "⧗",
	completed: "☑",
} as const;

/** One-line ambient summary, or `undefined` when there is nothing to say. */
export function summaryLine(state: TaskListState): string | undefined {
	if (state.tasks.length === 0) return undefined;
	const { pending, inProgress, completed } = counts(state);
	return `tasks ${GLYPHS.pending} ${pending} · ${GLYPHS.in_progress} ${inProgress} · ${GLYPHS.completed} ${completed}`;
}

function renderTask(task: TaskItem): string {
	const parts = [`  ${GLYPHS[task.status]} ${task.id}  ${task.subject}`];
	if (task.linearKey) parts.push(`⟨${task.linearKey}⟩`);
	if (task.owner) parts.push(`[${task.owner}]`);
	if (task.blockedBy && task.blockedBy.length > 0) parts.push(`(blocked by ${task.blockedBy.join(", ")})`);
	return parts.join(" ");
}

export interface RenderOptions {
	/** Include descriptions. Off for the ambient overlay, on when the model asked for detail. */
	verbose?: boolean;
}

/**
 * The full list.
 *
 * Insertion order, never sorted by status. The order is the model's own plan;
 * re-sorting it under the model makes ids move between turns and makes a plan
 * read as though it changed when only its rendering did.
 */
export function renderList(state: TaskListState, options: RenderOptions = {}): string {
	if (state.tasks.length === 0) return "No tasks.";

	const { pending, inProgress, completed } = counts(state);
	const lines = [`tasks: ${pending} to do · ${inProgress} in progress · ${completed} done`];

	for (const task of state.tasks) {
		lines.push(renderTask(task));
		if (options.verbose && task.description) lines.push(`      ${task.description}`);
	}

	const dangling = danglingBlockers(state);
	if (dangling.length > 0) {
		lines.push("");
		// Reported, never repaired. The edge may name a task the user is about to
		// re-create, and silently dropping it would lose that intent.
		for (const entry of dangling) {
			lines.push(`  note: task ${entry.id} is blocked by missing task(s) ${entry.missing.join(", ")}`);
		}
	}

	return lines.join("\n");
}

/** Detail for a single task. Returns `undefined` when the id is unknown. */
export function renderTaskDetail(task: TaskItem | undefined): string | undefined {
	if (!task) return undefined;
	const lines = [`${GLYPHS[task.status]} ${task.id}  ${task.subject}`, `  status: ${task.status}`];
	if (task.activeForm) lines.push(`  active form: ${task.activeForm}`);
	if (task.linearKey) lines.push(`  linear: ${task.linearKey}`);
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	if (task.blockedBy && task.blockedBy.length > 0) lines.push(`  blocked by: ${task.blockedBy.join(", ")}`);
	if (task.description) lines.push("", task.description);
	return lines.join("\n");
}

/** What a mutating call reports back: what changed, then the whole list. */
export function renderWriteResult(
	result: { created: string[]; updated: string[]; removed: string[]; problems: string[] },
	state: TaskListState,
): string {
	const changes: string[] = [];
	if (result.created.length > 0) changes.push(`created ${result.created.join(", ")}`);
	if (result.updated.length > 0) changes.push(`updated ${result.updated.join(", ")}`);
	if (result.removed.length > 0) changes.push(`removed ${result.removed.join(", ")}`);

	const lines: string[] = [];
	// Problems first. Buried under a rendered list they get skimmed past, and the
	// whole point of a partial apply is that the caller notices what did not land.
	for (const problem of result.problems) lines.push(`! ${problem}`);
	lines.push(changes.length > 0 ? changes.join(" · ") : "no changes");
	lines.push("");
	lines.push(renderList(state));
	return lines.join("\n");
}
