/**
 * The text of a finished orchestration run, and how it is paged.
 *
 * The result used to be `JSON.stringify(summary.results).slice(0, 24_000)`:
 * cut mid-string with nothing saying so ("ended mid-string in reviews#2
 * ('disappe')", papercut 2026-10-02T14:14), the reconciler's verdict past the
 * cut unreachable, and `orchestrate_result` able to return only that same
 * text. Three changes, all pure and here:
 *
 *   - results render per NODE, in plan order, as their own text — a worker's
 *     report is prose, and JSON-escaping it made every newline `\n`;
 *   - a barrier renders as the list of what it joined, not a second copy of
 *     those results (the join used to repeat ~20KB of its members);
 *   - every cut is a PAGE with a footer stating the range, the total, and the
 *     exact call that returns the rest — or one node.
 */

import type { RunSummary } from "./executor.ts";
import type { Plan } from "./plan-schema.ts";
import { renderInputValue } from "./upstream.ts";

/** What one page of run output shows by default. */
export const RESULT_PAGE_CHARS = 24_000;

/** Every id `orchestrate_result({node})` accepts for this run, in plan order. */
export function selectableNodes(plan: Plan, summary: RunSummary): string[] {
	const ids: string[] = [];
	for (const node of plan.nodes) {
		ids.push(node.id);
		const value = summary.results[node.id];
		if ((node.kind === "fanout" || node.kind === "pipeline") && Array.isArray(value)) {
			value.forEach((_, index) => ids.push(`${node.id}#${index}`));
		}
	}
	return ids;
}

/**
 * One node's result as text, or undefined for an id this run does not have.
 * `reviews#2` is element 2 of a fanout/pipeline, whatever stage it ended on.
 */
export function nodeResultText(plan: Plan, summary: RunSummary, id: string): string | undefined {
	if (!selectableNodes(plan, summary).includes(id)) return undefined;
	const slot = /^(.+)#(\d+)$/.exec(id);
	if (slot) {
		const items = summary.results[slot[1]];
		return renderInputValue(Array.isArray(items) ? items[Number(slot[2])] : undefined);
	}
	const node = plan.nodes.find((candidate) => candidate.id === id);
	const status = summary.state.status[id];
	if (!(id in summary.results)) return `(no result: ${status ?? "never ran"})`;
	if (node?.kind === "barrier") {
		return `(barrier — joins ${node.needs.join(", ")}; each result is under its own node)`;
	}
	return renderInputValue(summary.results[id]);
}

/** Every node's result, in plan order, each under its own heading. */
export function renderRunResults(plan: Plan, summary: RunSummary): string {
	const sections: string[] = [];
	for (const node of plan.nodes) {
		const value = summary.results[node.id];
		if ((node.kind === "fanout" || node.kind === "pipeline") && Array.isArray(value)) {
			value.forEach((_, index) => {
				const id = `${node.id}#${index}`;
				sections.push(`### ${id}\n${nodeResultText(plan, summary, id)}`);
			});
			continue;
		}
		sections.push(`### ${node.id}\n${nodeResultText(plan, summary, node.id)}`);
	}
	return sections.join("\n\n");
}

export interface Page {
	/** The characters shown. */
	page: string;
	/** Where the next page starts; absent when this page reaches the end. */
	nextOffset?: number;
	/** The sentence that goes after the page — always present, never silent. */
	footer: string;
}

/**
 * Characters `[offset, offset + limit)` of `text`, with a footer that says
 * exactly that. `more` renders the call that fetches page N+1.
 */
export function pageText(text: string, offset: number, limit: number, more: (nextOffset: number) => string): Page {
	const start = Math.max(0, Math.min(offset, text.length));
	const end = Math.min(text.length, start + Math.max(1, limit));
	const page = text.slice(start, end);
	if (end >= text.length) {
		const range = start === 0 ? `all ${text.length} characters` : `characters ${start}–${end} of ${text.length}`;
		return { page, footer: `[${range} — complete]` };
	}
	return {
		page,
		nextOffset: end,
		footer: `[showing characters ${start}–${end} of ${text.length}; ${text.length - end} more — ${more(end)} for the next page]`,
	};
}
