/**
 * Markdown and one-line renders of the workflow document.
 *
 * The model never sees the document any other way: a custom session entry is
 * structurally invisible to the LLM, and this repo bans the `context` handler
 * that would inject it. So the TOOL RESULT is the only view, and it has to be
 * complete — the same contract `tasks/render.ts` and `plan/render.ts` hold.
 *
 * Every function here is pure and takes the document, so a renderer can never
 * be the reason a tool call fails.
 *
 * One thing this render does that the browser's does not: it marks the steps
 * whose status is NOT the agent's to set. The browser shows that as a rim
 * treatment; here it is a word, because the reader is the model and the model
 * is the one that needs to stop writing those statuses.
 */

import { activeFront, treeOrder } from "./graph.ts";
import {
	currentStage,
	OBSERVED_KINDS,
	stepCounts,
	TASK_KIND,
	type WorkflowDoc,
	type WorkflowStatus,
	type WorkflowStep,
} from "./state.ts";

const STATUS_BOX: Record<WorkflowStatus, string> = {
	pending: "[ ]",
	running: "[~]",
	done: "[x]",
	failed: "[!]",
	skipped: "[-]",
	blocked: "[?]",
};

export function workflowToMarkdown(doc: WorkflowDoc): string {
	const out: string[] = [];
	if (doc.title) out.push(`# ${doc.title}`, "");
	if (doc.goal) out.push(`**Goal:** ${doc.goal}`, "");

	if (doc.stages.length === 0) {
		out.push("_No stages yet._");
		return out.join("\n");
	}

	for (const stage of doc.stages) {
		out.push(`## ${STATUS_BOX[stage.status]} ${stage.title}  \`${stage.id}\`${loopSuffix(stage.loop)}`);
		if (stage.steps.length === 0) {
			out.push("_(no steps)_", "");
			continue;
		}
		// Tree order, indented by depth. The nesting has to be VISIBLE here or the
		// model cannot see the structure it built — the tool result is its only
		// view of the document, and a flat list would read as though `parentId` had
		// done nothing.
		for (const { step, depth } of treeOrder(stage)) {
			const pad = "  ".repeat(depth - 1);
			out.push(`${pad}- ${STATUS_BOX[step.status]} ${step.title}  \`${step.id}\`${stepSuffix(step)}`);
			if (step.detail) out.push(`${pad}      ${step.detail}`);
			if (step.note) out.push(`${pad}      note: ${step.note}`);
		}
		out.push("");
	}

	return out.join("\n").trimEnd();
}

/**
 * The trailing annotations on a step line.
 *
 * "resolved by Hive" is the important one and it is stated per step rather than
 * once at the top: a model reading a lane of five steps needs the mark next to
 * the status it was about to set, not in a preamble it has already scrolled past.
 */
function loopSuffix(loop: { iteration?: number; until?: string } | undefined): string {
	if (!loop) return "";
	return `  ↻ wave ${loop.iteration ?? 1}${loop.until ? ` — until: ${loop.until}` : ""}`;
}

function stepSuffix(step: WorkflowStep): string {
	const bits: string[] = [];
	if (step.kind !== TASK_KIND) bits.push(step.kind);
	if (OBSERVED_KINDS.includes(step.kind)) bits.push("resolved by Hive");
	if (step.linearKey) bits.push(step.linearKey);
	if (step.dependsOn && step.dependsOn.length > 0) bits.push(`after ${step.dependsOn.join(", ")}`);
	if (step.taskId) bits.push("from your task list");
	return bits.length > 0 ? `  _(${bits.join(" · ")})_` : "";
}

/**
 * The tool result: the document, what the batch refused, and anything it wants
 * to tell you about what it DID.
 *
 * The two are separate arguments because they are separate claims, and sorting
 * one list into them by its first word was wrong in both directions. Refusals
 * opening with the noun they refuse (`stage limit reached (12)`, `step limit
 * reached for s1`, `stage s1 already carries the delivery lane`) matched the
 * success shape and vanished — a partial apply the model never saw, which is
 * precisely what the loud heading exists to prevent. And the alias notice added
 * for `plan_write`'s spelling matched neither, so "Applied `set_step` → `step`"
 * was printed under **Not applied** — a result that contradicts itself, and the
 * one an operator reported.
 */
export function renderWorkflow(
	doc: WorkflowDoc,
	refused: readonly string[],
	notices: readonly string[] = [],
): string {
	const body = workflowToMarkdown(doc);
	const out = [body];
	// Refusals are LOUD. A partial apply the model never sees is how it goes on
	// believing it recorded something it did not.
	if (refused.length > 0) out.push("", "**Not applied:**", ...refused.map((n) => `- ${n}`));
	// A notice is about what DID happen, so it neither shouts nor sits under a
	// heading that denies it.
	if (notices.length > 0) out.push("", ...notices.map((n) => `_${n}_`));
	return out.join("\n");
}

/**
 * One line for the transcript: where this session is, and how much is left.
 *
 * "Where" is still ONE stage, deliberately, even though the front can be plural
 * — a status line has room for a place, not for a set. The count of live steps
 * is appended instead when there is more than one, because "3 live" is the part
 * of the plural answer that fits and the part that changes what an operator does.
 */
export function summaryLine(doc: WorkflowDoc): string {
	if (doc.stages.length === 0) return "⛭ workflow · empty";
	const counts = stepCounts(doc);
	const stage = currentStage(doc);
	const front = activeFront(doc).filter((s) => !OBSERVED_KINDS.includes(s.kind));
	const where = stage ? `${stage.title}${front.length > 1 ? ` · ${front.length} live` : ""}` : "done";
	// The tally counts only the steps whose status is actually read here —
	// stating a total that includes Hive-resolved steps would disagree with the
	// browser, and the browser's reading is the true one.
	return counts.total === 0
		? `⛭ workflow · ${where}`
		: `⛭ workflow · ${where} · ${counts.done}/${counts.total}`;
}
