/**
 * Markdown and TUI renders of the plan document.
 *
 * One document, several renderers — this is the half that makes the block model
 * pay off. The same `PlanDoc` becomes markdown here (for the model's tool
 * result, `/plan export`, a Linear description, a PR body), a one-line widget in
 * the TUI, and rich HTML in the Hive plan tab. None of those is the storage.
 *
 * Every function here is pure and takes the document, so a renderer can never
 * be the reason a tool call fails.
 *
 * On charts: a `chart` block renders as a table plus a text bar. That is
 * deliberately unglamorous — markdown has no charts, and the honest fallback is
 * the DATA, which is exactly what the block stores. A viewer that can draw gets
 * the same numbers and draws them.
 *
 * On artifacts: an `artifact` block renders as a NOTICE, never as its html. The
 * whole safety of that block is that its document is only ever handed to a
 * sandboxed frame with an opaque origin; markdown has no sandbox, and these
 * renders feed a Linear description, a PR body and the model's own tool result.
 * So the markdown says the artifact exists and how large it is, and stops. This
 * is the one block the fallback cannot approximate, which is exactly why the
 * prompt tells the agent to reach for it last.
 */

import {
	allSteps,
	stepCounts,
	type ChartBlock,
	type PlanBlock,
	type PlanDoc,
	type PlanStep,
	type StepStatus,
} from "./state.ts";

const STATUS_BOX: Record<StepStatus, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	done: "[x]",
	// Distinct from `blocked`: "tried it and it did not work" is not "waiting on
	// something", and a reader deciding what to do next needs the difference.
	failed: "[×]",
	skipped: "[-]",
	blocked: "[!]",
};

const STATUS_WORD: Record<StepStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	done: "done",
	failed: "failed",
	skipped: "skipped",
	blocked: "blocked",
};

/* -------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* -------------------------------------------------------------------------- */

export function planToMarkdown(doc: PlanDoc, options: { includeIds?: boolean } = {}): string {
	const includeIds = options.includeIds ?? true;
	const out: string[] = [];

	out.push(`# ${doc.title || "Untitled plan"}`);
	if (doc.goal) out.push("", `**Goal.** ${doc.goal}`);

	const counts = stepCounts(doc);
	const meta = [`phase: ${doc.phase}`, `revision: ${doc.revision}`];
	if (counts.total > 0) meta.push(`steps: ${counts.done}/${counts.total} done`);
	out.push("", `*${meta.join(" · ")}*`);

	for (const block of doc.blocks) {
		out.push("", ...blockToMarkdown(block, includeIds));
	}

	return out.join("\n").trimEnd() + "\n";
}

function blockToMarkdown(block: PlanBlock, includeIds: boolean): string[] {
	const out: string[] = [];
	// The id belongs in the heading, not in a comment: it is how the model
	// addresses the block on the next patch, so it has to survive being read
	// back as plain text.
	const tag = includeIds ? ` <sub>\`#${block.id}\`</sub>` : "";
	if (block.title) out.push(`## ${block.title}${tag}`, "");
	else if (includeIds) out.push(`<sub>\`#${block.id}\`</sub>`, "");

	switch (block.type) {
		case "text":
			out.push(block.markdown);
			break;

		case "callout": {
			const sigil = { info: "ℹ️", warn: "⚠️", risk: "🔥", success: "✅" }[block.tone];
			out.push(`> ${sigil} **${block.tone.toUpperCase()}** — ${block.markdown.replace(/\n/g, "\n> ")}`);
			break;
		}

		case "steps":
			for (const step of block.steps) out.push(...stepToMarkdown(step, includeIds));
			break;

		case "diagram":
			out.push("```mermaid", block.mermaid, "```");
			if (block.caption) out.push("", `*${block.caption}*`);
			break;

		case "chart":
			out.push(...chartToMarkdown(block));
			break;

		case "refs":
			for (const ref of block.refs) {
				const kind = ref.kind ? `\`${ref.kind}\` ` : "";
				const link = ref.url ? `[${ref.label}](${ref.url})` : ref.label;
				out.push(`- ${kind}${link}${ref.note ? ` — ${ref.note}` : ""}`);
			}
			break;

		case "table":
			out.push(`| ${block.columns.join(" | ")} |`);
			out.push(`| ${block.columns.map(() => "---").join(" | ")} |`);
			for (const row of block.rows) out.push(`| ${row.map(escapeCell).join(" | ")} |`);
			break;

		case "metrics":
			for (const metric of block.metrics) {
				out.push(`- **${metric.label}**: ${metric.value}${metric.delta ? ` (${metric.delta})` : ""}`);
			}
			break;

		case "code":
			out.push("```" + (block.language ?? ""), block.code, "```");
			if (block.caption) out.push("", `*${block.caption}*`);
			break;

		case "checklist":
			for (const item of block.items) out.push(`- ${item.checked ? "[x]" : "[ ]"} ${item.text}${item.evidence ? ` — ${item.evidence}` : ""}`);
			break;

		case "ticket":
			out.push(`- ${block.role ? `\`${block.role}\` ` : ""}${block.url ? `[${block.key}](${block.url})` : block.key}`);
			break;

		case "milestone":
			out.push(`- Goal: \`${block.goalId}\`${block.stepId ? ` · step \`${block.stepId}\`` : ""}`);
			break;

		case "decision":
			out.push(`**Question:** ${block.question}`, "", ...block.options.map((option) => `- ${option === block.chosen ? "[x]" : "[ ]"} ${option}`), "", `**Rationale:** ${block.rationale}`);
			break;

		case "log":
			for (const entry of block.entries) out.push(`- ${new Date(entry.at).toISOString()} · \`${entry.kind}\` · ${entry.text}`);
			break;

		case "artifact":
			// NOT the html. Markdown has no sandbox, and this render feeds a Linear
			// description, a PR body and the model's own tool result — pasting a
			// live document into any of those is the one thing the sandbox exists to
			// prevent. What markdown can honestly carry is that the block exists,
			// how big it is, and where to look at it.
			out.push(
				`> 🖼 **Interactive artifact**${block.caption ? ` — ${block.caption}` : ""}`,
				">",
				`> A self-contained HTML document (${block.html.length} characters), rendered in a`,
				"> sandboxed frame by the web plan view. It is not reproduced here.",
			);
			break;
	}

	return out;
}

function stepToMarkdown(step: PlanStep, includeIds: boolean): string[] {
	const out: string[] = [];
	const id = includeIds ? `\`${step.id}\` ` : "";
	const owner = step.owner ? ` _(@${step.owner})_` : "";
	const linear = step.linearKey ? ` [${step.linearKey}]` : "";
	out.push(`- ${STATUS_BOX[step.status]} ${id}${step.title}${linear}${owner}`);
	if (step.detail) out.push(`      ${step.detail}`);
	if (step.files?.length) out.push(`      files: ${step.files.map((file) => `\`${file}\``).join(", ")}`);
	if (step.blockedBy?.length) out.push(`      blocked by: ${step.blockedBy.join(", ")}`);
	// The drift record is rendered as its own emphasized line rather than folded
	// into the title, because "what actually happened" losing to "what we said
	// would happen" is the failure this field exists to prevent.
	if (step.note) out.push(`      ↳ _${step.note}_`);
	return out;
}

/**
 * A chart, as data plus an ASCII bar.
 *
 * The bar is scaled to the largest absolute value in the series so a single
 * outlier cannot flatten everything else to nothing.
 */
function chartToMarkdown(block: ChartBlock): string[] {
	const out: string[] = [];
	const unit = block.unit ? ` ${block.unit}` : "";
	const peak = block.series.reduce((max, point) => Math.max(max, Math.abs(point.value)), 0);
	const width = 24;
	const pad = block.series.reduce((max, point) => Math.max(max, point.label.length), 0);

	out.push("```");
	for (const point of block.series) {
		const filled = peak === 0 ? 0 : Math.round((Math.abs(point.value) / peak) * width);
		const bar = "█".repeat(filled).padEnd(width, "·");
		out.push(`${point.label.padEnd(pad)}  ${bar}  ${point.value}${unit}`);
	}
	out.push("```");
	if (block.caption) out.push("", `*${block.caption}*`);
	return out;
}

function escapeCell(cell: string): string {
	return cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/* -------------------------------------------------------------------------- */
/* Tool results and the TUI                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One line for the status widget, or `undefined` when there is nothing to say.
 *
 * `undefined` rather than an empty string because `ctx.ui.setWidget` treats
 * undefined as "remove the widget"; an empty string leaves a blank row.
 */
export function summaryLine(doc: PlanDoc): string | undefined {
	if (doc.blocks.length === 0 && !doc.title) return undefined;
	const counts = stepCounts(doc);
	const bits: string[] = [`plan: ${doc.phase}`];
	if (counts.total > 0) {
		bits.push(`${counts.done}/${counts.total} done`);
		if (counts.in_progress > 0) bits.push(`${counts.in_progress} active`);
		if (counts.blocked > 0) bits.push(`${counts.blocked} blocked`);
	}
	if (doc.revision > 0) bits.push(`rev ${doc.revision}`);
	return bits.join(" · ");
}

/**
 * What a mutating tool call returns.
 *
 * Problems come FIRST. A model that has to read past a rendered plan to notice
 * three rejected ops usually does not, and then re-states the plan it thinks it
 * wrote — which is how a silent partial apply becomes a wrong plan.
 */
export function renderOpResult(
	result: { created: string[]; updated: string[]; removed: string[]; problems: string[] },
	doc: PlanDoc,
): string {
	const out: string[] = [];

	if (result.problems.length > 0) {
		out.push(`${result.problems.length} problem(s):`);
		for (const problem of result.problems) out.push(`  - ${problem}`);
		out.push("");
	}

	const applied: string[] = [];
	if (result.created.length > 0) applied.push(`created ${result.created.join(", ")}`);
	if (result.updated.length > 0) applied.push(`updated ${result.updated.join(", ")}`);
	if (result.removed.length > 0) applied.push(`removed ${result.removed.join(", ")}`);
	out.push(applied.length > 0 ? `Applied: ${applied.join("; ")}.` : "No changes applied.");

	const dangling = allSteps(doc).filter((step) => (step.blockedBy ?? []).length > 0);
	const live = new Set(allSteps(doc).map((step) => step.id));
	const broken = dangling
		.map((step) => ({ id: step.id, missing: (step.blockedBy ?? []).filter((b) => !live.has(b)) }))
		.filter((entry) => entry.missing.length > 0);
	if (broken.length > 0) {
		out.push("");
		out.push("Dangling blockers (recorded, not repaired):");
		for (const entry of broken) out.push(`  - step ${entry.id} waits on ${entry.missing.join(", ")}`);
	}

	out.push("", planToMarkdown(doc));
	return out.join("\n");
}

/** A compact one-per-step listing, for `/plan status` and worker handoffs. */
export function renderStepList(doc: PlanDoc): string {
	const steps = allSteps(doc);
	if (steps.length === 0) return "The plan has no steps yet.";
	return steps
		.map((step) => {
			const owner = step.owner ? ` (@${step.owner})` : "";
			return `${STATUS_BOX[step.status]} ${step.id}. ${step.title}${owner} — ${STATUS_WORD[step.status]}`;
		})
		.join("\n");
}
