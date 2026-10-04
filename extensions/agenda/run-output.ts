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
 *     exact call that returns the rest — or one node;
 *   - worker text is FENCED as data (harness/fence.ts): it reaches the parent
 *     as a user-role message, and unfenced prose could forge headings there.
 */

import type { RunSummary } from "./executor.ts";
import type { Plan, PlanNode } from "./plan-schema.ts";
import { FENCED_DATA_NOTE, fence, nonceFor } from "../harness/fence.ts";
import { renderInputValue } from "./upstream.ts";

/** What one page of run output shows by default. */
export const RESULT_PAGE_CHARS = 24_000;

/** The most one page may show, whatever `limit` asks for — a page is context. */
export const MAX_RESULT_PAGE_CHARS = 100_000;

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/**
 * The finished elements of a fanout/pipeline, read from their own result
 * slots — NOT from the node's aggregate, which exists only once every element
 * finished. A fanout of 10 with one failure still has 9 results worth reading.
 * A pipeline element's result is its furthest finished stage.
 */
function elementResults(node: PlanNode, summary: RunSummary): Array<{ id: string; value: unknown }> {
	const latest = new Map<number, { stage: number; value: unknown }>();
	const pattern = node.kind === "pipeline" ? /^(.+)#(\d+)@(\d+)$/ : /^(.+)#(\d+)$/;
	for (const [key, value] of Object.entries(summary.results)) {
		const match = pattern.exec(key);
		if (!match || match[1] !== node.id) continue;
		const index = Number(match[2]);
		const stage = match[3] === undefined ? 0 : Number(match[3]);
		const seen = latest.get(index);
		if (!seen || stage > seen.stage) latest.set(index, { stage, value });
	}
	return [...latest.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, { value }]) => ({ id: `${node.id}#${index}`, value }));
}

/** Every id `orchestrate_result({node})` accepts for this run, in plan order. */
export function selectableNodes(plan: Plan, summary: RunSummary): string[] {
	const ids: string[] = [];
	for (const node of plan.nodes) {
		ids.push(node.id);
		if (node.kind === "fanout" || node.kind === "pipeline") {
			for (const element of elementResults(node, summary)) ids.push(element.id);
		}
	}
	return ids;
}

/** A node's result: worker-produced text, or a placeholder the harness wrote. */
interface NodeResult {
	text: string;
	/** True when `text` came from a worker — the part that must be fenced. */
	worker: boolean;
}

function nodeResult(plan: Plan, summary: RunSummary, id: string): NodeResult | undefined {
	if (!selectableNodes(plan, summary).includes(id)) return undefined;
	const slot = /^(.+)#(\d+)$/.exec(id);
	if (slot) {
		const owner = plan.nodes.find((candidate) => candidate.id === slot[1]);
		const element = owner ? elementResults(owner, summary).find((candidate) => candidate.id === id) : undefined;
		return { text: renderInputValue(element?.value), worker: true };
	}
	const node = plan.nodes.find((candidate) => candidate.id === id);
	const status = summary.state.status[id];
	if (node?.kind === "barrier" && id in summary.results) {
		return { text: `(barrier — joins ${node.needs.join(", ")}; each result is under its own node)`, worker: false };
	}
	if ((node?.kind === "fanout" || node?.kind === "pipeline") && !(id in summary.results)) {
		const finished = elementResults(node, summary).length;
		return { text: `(no combined result: ${status ?? "never ran"}; ${finished} element(s) finished, each under <id>#<n>)`, worker: false };
	}
	if (!(id in summary.results)) return { text: `(no result: ${status ?? "never ran"})`, worker: false };
	return { text: renderInputValue(summary.results[id]), worker: true };
}

/**
 * One node's result as raw text, or undefined for an id this run does not
 * have. `reviews#2` is element 2 of a fanout/pipeline, whatever stage it ended
 * on. UNFENCED — for anything a model reads, use `fencedNodeResult`.
 */
export function nodeResultText(plan: Plan, summary: RunSummary, id: string): string | undefined {
	return nodeResult(plan, summary, id)?.text;
}

const WORKER_LABEL = "WORKER OUTPUT";

/** `orchestrate_result({node})`'s body: the data note, then the result fenced when a worker wrote it. */
export function fencedNodeResult(plan: Plan, summary: RunSummary, id: string): string | undefined {
	const result = nodeResult(plan, summary, id);
	if (!result) return undefined;
	if (!result.worker) return result.text;
	return `${FENCED_DATA_NOTE}\n\n${fence(WORKER_LABEL, `node=${id}`, result.text, nonceFor([result.text]))}`;
}

/**
 * Every node's result, in plan order, each under its own heading — worker text
 * FENCED with one nonce per render that no result contains.
 *
 * This text reaches the parent as a user-role message (the background-run
 * completion) or a tool result. The old JSON escaping incidentally kept a
 * worker from forging structure in it; the fence does that on purpose, and the
 * leading note says what the fence means.
 */
export function renderRunResults(plan: Plan, summary: RunSummary): string {
	const entries: Array<{ id: string; result: NodeResult }> = [];
	for (const node of plan.nodes) {
		if (node.kind === "fanout" || node.kind === "pipeline") {
			if (!(node.id in summary.results)) entries.push({ id: node.id, result: nodeResult(plan, summary, node.id)! });
			for (const element of elementResults(node, summary)) {
				entries.push({ id: element.id, result: { text: renderInputValue(element.value), worker: true } });
			}
			continue;
		}
		entries.push({ id: node.id, result: nodeResult(plan, summary, node.id)! });
	}
	const nonce = nonceFor(entries.filter((entry) => entry.result.worker).map((entry) => entry.result.text));
	const sections = entries.map(({ id, result }) =>
		`### ${id}\n${result.worker ? fence(WORKER_LABEL, `node=${id}`, result.text, nonce) : result.text}`,
	);
	return [FENCED_DATA_NOTE, "", ...sections.flatMap((section, index) => (index === 0 ? [section] : ["", section]))].join("\n");
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
	let end = Math.min(text.length, start + Math.max(1, Math.min(limit, MAX_RESULT_PAGE_CHARS)));
	// Never end a page between the two UTF-16 halves of one character: each
	// half alone renders as U+FFFD on both pages. The pair moves to the next.
	if (end < text.length && end - 1 > start && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
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
