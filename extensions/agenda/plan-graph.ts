/**
 * Node identity, reference resolution, and the scheduler — all pure.
 *
 * `nextBatch` is the whole point of the declarative design: deciding what to
 * dispatch next is a fold over (plan, completed, running, caps), so the entire
 * scheduling surface — concurrency, dependencies, pipelines advancing
 * independently, budget exhaustion — is testable with zero child processes.
 * A script runtime cannot offer that.
 */

import { createHash } from "node:crypto";
import { dependenciesOf, isAgentBearing, type Plan, type PlanNode, type ResolvedCaps } from "./plan-schema.ts";
import { getPath } from "./transform.ts";

/**
 * Content-derived work id.
 *
 * Resume falls out of this: editing one node's prompt changes only that node's
 * id, so a resumed run re-executes it and its dependents and replays everything
 * else from the journal. Claude Code gets the same effect by replaying its
 * script in call order, which is why its scripts may not call `Date.now()`;
 * here it is a property of the representation rather than a restriction on the
 * author.
 *
 * The item key is included so each element of a fanout gets its own identity —
 * otherwise a resumed fanout would replay one result for all N items.
 */
export function workId(node: PlanNode, itemKey = "", stageIndex = 0): string {
	const spec = node as Record<string, unknown>;
	const material = JSON.stringify([
		node.kind,
		spec.role ?? "",
		typeof spec.prompt === "string" ? spec.prompt.trim().replace(/\s+/g, " ") : "",
		spec.op ?? null,
		spec.outputSchema ?? null,
		stageIndex,
		itemKey,
	]);
	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface RunState {
	/** Result per node id. Absent means not finished. */
	results: Record<string, unknown>;
	status: Record<string, NodeStatus>;
	/** Work ids currently dispatched. */
	running: Set<string>;
	agentsSpawned: number;
	spentTokens: number;
	/** Dollars. Not derivable from spentTokens: nodes may pick their own model. */
	spentCost: number;
}

export function emptyRunState(): RunState {
	return { results: {}, status: {}, running: new Set(), agentsSpawned: 0, spentTokens: 0, spentCost: 0 };
}

/** Resolve `"<nodeId>.<field>"` against finished results. */
export function resolveRef(ref: string, results: Record<string, unknown>): unknown {
	const [nodeId, ...rest] = ref.split(".");
	if (!(nodeId in results)) return undefined;
	return rest.length === 0 ? results[nodeId] : getPath(results[nodeId], rest.join("."));
}

export interface Dispatch {
	/** Stable work id — the journal's key, and what resume matches on. */
	workId: string;
	nodeId: string;
	kind: "agent";
	role: string;
	prompt: string;
	model?: string;
	outputSchema?: unknown;
	isolation?: "none" | "worktree";
	/** Which element of a fanout/pipeline this is, when it is one. */
	item?: unknown;
	/**
	 * That element's position. Carried explicitly rather than recovered from the
	 * item's value — two identical items must still get distinct result slots.
	 */
	itemIndex?: number;
	/** Which pipeline stage this is. */
	stageIndex?: number;
	/** Retry budget for this unit of work. */
	retries?: number;
}

export interface BatchResult {
	dispatch: Dispatch[];
	/** Nodes that became runnable and finished without spawning anything. */
	immediate: Array<{ nodeId: string; value: unknown }>;
	/** Set when the run cannot proceed. */
	halt?: "budget" | "agents";
}

function dependenciesSatisfied(node: PlanNode, state: RunState): boolean {
	return dependenciesOf(node).every((dep) => state.status[dep] === "done");
}

/**
 * Decide what to dispatch next.
 *
 * Admission caps are enforced here. `maxAgents` is hard. `budgetTokens` is
 * observed between workers (a model turn cannot be preempted at an exact token),
 * and budgeted runs are serialized below so the maximum overshoot is one worker
 * rather than a whole wave. An advisory budget is a budget that gets ignored.
 */
export function nextBatch(plan: Plan, state: RunState, caps: ResolvedCaps): BatchResult {
	const dispatch: Dispatch[] = [];
	const immediate: Array<{ nodeId: string; value: unknown }> = [];

	if (caps.budgetTokens !== undefined && state.spentTokens >= caps.budgetTokens) {
		return { dispatch: [], immediate: [], halt: "budget" };
	}
	if (state.agentsSpawned >= caps.maxAgents) {
		return { dispatch: [], immediate: [], halt: "agents" };
	}

	// A token budget cannot preempt a one-shot model call mid-turn. Serial
	// admission keeps the unavoidable overshoot bounded to ONE worker rather than
	// a whole concurrent batch (a 50k plan was measured at 373k before this).
	const concurrency = caps.budgetTokens === undefined ? caps.maxConcurrent : 1;
	let slots = concurrency - state.running.size;
	let budgetedAgents = caps.maxAgents - state.agentsSpawned;

	for (const node of plan.nodes) {
		const status = state.status[node.id];
		if (status === "done" || status === "failed" || status === "skipped" || status === "running") continue;
		if (!dependenciesSatisfied(node, state)) continue;

		// Bookkeeping nodes finish the moment their inputs exist. They cost
		// nothing and must not consume a concurrency slot.
		if (node.kind === "barrier") {
			immediate.push({ nodeId: node.id, value: (node.needs ?? []).map((ref) => resolveRef(ref, state.results)) });
			continue;
		}
		if (node.kind === "transform") {
			immediate.push({ nodeId: node.id, value: { __transform: node.op, input: resolveRef(node.over, state.results) } });
			continue;
		}

		// Collection nodes publish ONE ordered node-level result after all of their
		// internal work slots finish. The slots stay in `results` for resume and
		// diagnostics, while this aggregate is what a valid Ref (`fanout`, not the
		// intentionally unaddressable `fanout#3`) can feed into a downstream join.
		// Empty collections finish as [] rather than leaving the run incomplete.
		if (node.kind === "fanout") {
			const items = asItems(resolveRef(node.over, state.results));
			if (items.every((_, index) => state.status[`${node.id}#${index}`] === "done")) {
				immediate.push({ nodeId: node.id, value: items.map((_, index) => state.results[`${node.id}#${index}`]) });
				continue;
			}
		}
		if (node.kind === "pipeline") {
			const items = asItems(resolveRef(node.over, state.results));
			const lastStage = node.stages.length - 1;
			if (items.every((_, index) => state.status[`${node.id}#${index}@${lastStage}`] === "done")) {
				immediate.push({
					nodeId: node.id,
					value: items.map((_, index) => state.results[`${node.id}#${index}@${lastStage}`]),
				});
				continue;
			}
		}

		if (slots <= 0 || budgetedAgents <= 0) continue;

		if (node.kind === "agent") {
			dispatch.push({
				workId: workId(node),
				nodeId: node.id,
				kind: "agent",
				role: node.role,
				prompt: node.prompt,
				model: node.model,
				outputSchema: node.outputSchema,
				isolation: node.isolation,
				retries: node.retries,
			});
			slots--;
			budgetedAgents--;
			continue;
		}

		if (node.kind === "fanout") {
			const items = asItems(resolveRef(node.over, state.results));
			for (let index = 0; index < items.length && slots > 0 && budgetedAgents > 0; index++) {
				const item = items[index];
				const key = `${index}:${stableItemKey(item)}`;
				const id = workId(node, key);
				if (state.running.has(id) || state.status[`${node.id}#${index}`] === "done") continue;
				dispatch.push({
					workId: id,
					nodeId: node.id,
					kind: "agent",
					role: node.role,
					prompt: node.prompt.replaceAll("{item}", renderItem(item)),
					model: node.model,
					outputSchema: node.outputSchema,
					isolation: node.isolation,
					item,
					itemIndex: index,
					retries: node.retries,
				});
				slots--;
				budgetedAgents--;
			}
			continue;
		}

		if (node.kind === "pipeline") {
			// Items advance INDEPENDENTLY — no barrier between stages. Item 2 can
			// be at stage 3 while item 5 is still at stage 1, so wall-clock is the
			// slowest single chain rather than the sum of slowest-per-stage.
			const items = asItems(resolveRef(node.over, state.results));
			for (let index = 0; index < items.length && slots > 0 && budgetedAgents > 0; index++) {
				const stageIndex = pipelineStageFor(state, node.id, index);
				if (stageIndex >= node.stages.length) continue; // this item is finished
				const stage = node.stages[stageIndex];
				const previous = stageIndex === 0 ? items[index] : state.results[`${node.id}#${index}@${stageIndex - 1}`];
				const id = workId(node, `${index}:${stableItemKey(items[index])}`, stageIndex);
				if (state.running.has(id)) continue;
				dispatch.push({
					workId: id,
					nodeId: node.id,
					kind: "agent",
					role: stage.role,
					prompt: stage.prompt.replaceAll("{item}", renderItem(previous)),
					model: stage.model,
					outputSchema: stage.outputSchema,
					isolation: stage.isolation,
					item: items[index],
					itemIndex: index,
					stageIndex,
					retries: stage.retries,
				});
				slots--;
				budgetedAgents--;
			}
		}
	}

	return { dispatch, immediate };
}

/** How far this pipeline item has advanced. */
function pipelineStageFor(state: RunState, nodeId: string, index: number): number {
	let stage = 0;
	while (state.status[`${nodeId}#${index}@${stage}`] === "done") stage++;
	return stage;
}

function asItems(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value === null || value === undefined) return [];
	return [value];
}

function stableItemKey(item: unknown): string {
	return typeof item === "string" ? item : JSON.stringify(item) ?? "";
}

function renderItem(item: unknown): string {
	return typeof item === "string" ? item : JSON.stringify(item, null, 2);
}

/** Has every node reached a terminal status? */
export function isComplete(plan: Plan, state: RunState): boolean {
	return plan.nodes.every((node) => {
		const status = state.status[node.id];
		return status === "done" || status === "failed" || status === "skipped";
	});
}

/**
 * Nodes that can never run because something they depend on failed.
 *
 * Reported as `skipped`, distinct from `failed`: a node that was never tried is
 * not a node that was tried and did not work, and a summary that conflates them
 * over-reports failures.
 */
export function skippableAfterFailure(plan: Plan, state: RunState): string[] {
	const doomed: string[] = [];
	for (const node of plan.nodes) {
		if (state.status[node.id]) continue;
		const deps = dependenciesOf(node);
		if (deps.some((dep) => state.status[dep] === "failed" || state.status[dep] === "skipped")) {
			doomed.push(node.id);
		}
	}
	return doomed;
}

/** How many workers this plan could spawn, for the pre-run confirmation. */
/**
 * Suggested orchestration caps for a plan of `stepCount` steps — quoted in the
 * conductor's execute kick so the model scales the run to the work instead of
 * defaulting blind. Suggestions only; the schema ceilings stay the law.
 */
export function suggestCaps(stepCount: number): { maxConcurrent: number; maxAgents: number } {
	const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
	return {
		// Four is a useful first wave for independent angles; two workers became
		// the model's habitual ceiling even when a plan exposed far more territory.
		maxConcurrent: clamp(Math.ceil(stepCount / 2) + 2, 4, 8),
		// This is total admissions across follow-up waves, not simultaneous load.
		// Keep the established 40-run ceiling until per-worker token reservation
		// closes the known batch-level budget overshoot; scale concurrency first.
		maxAgents: clamp(stepCount * 3 + 6, 12, 40),
	};
}

export function estimateAgents(plan: Plan, knownCounts: Record<string, number> = {}): number {
	let total = 0;
	for (const node of plan.nodes) {
		if (!isAgentBearing(node)) continue;
		if (node.kind === "agent") {
			total += 1;
		} else if (node.kind === "fanout") {
			total += knownCounts[node.id] ?? 1;
		} else if (node.kind === "pipeline") {
			total += (knownCounts[node.id] ?? 1) * node.stages.length;
		}
	}
	return total;
}
