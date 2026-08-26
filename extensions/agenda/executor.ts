/**
 * The run loop.
 *
 * The spawner is INJECTED rather than imported. That is not testing sugar: it
 * makes the loop — concurrency, dependency ordering, retries, budget stops,
 * failure propagation, the identical-failure collapse — testable with zero
 * child processes, which is the same reason the scheduler is a pure fold. The
 * real spawner is then a thin adapter with nothing interesting in it.
 *
 * The loop itself is deliberately dull: ask `nextBatch` what to do, do it,
 * fold the results, repeat. Everything clever lives in the pure modules.
 */

import { applyTransform } from "./transform.ts";
import {
	type Dispatch,
	emptyRunState,
	isComplete,
	nextBatch,
	type RunState,
	skippableAfterFailure,
} from "./plan-graph.ts";
import { type Plan, resolveCaps } from "./plan-schema.ts";

export interface WorkerResult {
	ok: boolean;
	/** Parsed structured output when the node asked for a schema, else raw text. */
	value: unknown;
	tokens: number;
	/** Dollars this worker spent, when the harness could observe them. */
	cost?: number;
	/** Normalised failure signature, for the identical-failure collapse. */
	error?: string;
}

export type Spawn = (dispatch: Dispatch, signal?: AbortSignal) => Promise<WorkerResult>;

export interface RunEvent {
	at: number;
	ev: "run_started" | "node_started" | "node_finished" | "node_failed" | "budget" | "halted" | "run_finished";
	workId?: string;
	nodeId?: string;
	reason?: string;
	attempts?: number;
	tokens?: number;
	/** Dollars — surfaced per node and for the run, so a fanout's spend is legible. */
	cost?: number;
}

export interface RunOptions {
	plan: Plan;
	spawn: Spawn;
	/** Appended to for the journal; the caller decides where it lands. */
	journal?: (event: RunEvent) => void;
	now?: () => number;
	signal?: AbortSignal;
	/** Resume: work ids already known to have finished, with their values. */
	completed?: Record<string, unknown>;
}

export interface RunSummary {
	state: RunState;
	results: Record<string, unknown>;
	halted?: "budget" | "agents" | "aborted";
	failures: Array<{ nodeId: string; error: string }>;
	agentsSpawned: number;
	spentTokens: number;
	/** Dollars for the whole run. */
	spentCost: number;
}

/**
 * Three nodes of one stage failing the same way is not three problems, it is
 * one problem being discovered in parallel. Continuing would spend the rest of
 * the fan-out rediscovering it.
 */
const IDENTICAL_FAILURE_THRESHOLD = 3;

/** Collapse an error to something comparable — numbers and paths vary, shapes do not. */
export function errorSignature(error: string): string {
	return error
		.toLowerCase()
		.replace(/\d+/g, "N")
		.replace(/['"`][^'"`]*['"`]/g, "S")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

export async function runPlan(options: RunOptions): Promise<RunSummary> {
	const now = options.now ?? (() => Date.now());
	const caps = resolveCaps(options.plan.caps);
	const journal = options.journal ?? (() => {});
	const state: RunState = emptyRunState();
	const failures: Array<{ nodeId: string; error: string }> = [];
	const failureSignatures = new Map<string, number>();
	let halted: RunSummary["halted"];

	// Resume: anything already finished is folded in before the first batch, so
	// `nextBatch` simply never proposes it again.
	for (const [workIdKey, value] of Object.entries(options.completed ?? {})) {
		state.results[workIdKey] = value;
		state.status[workIdKey] = "done";
	}

	journal({ at: now(), ev: "run_started" });

	while (!isComplete(options.plan, state)) {
		if (options.signal?.aborted) {
			halted = "aborted";
			break;
		}

		const batch = nextBatch(options.plan, state, caps);

		// Bookkeeping nodes first — they cost nothing and may unblock real work
		// within this same iteration.
		for (const item of batch.immediate) {
			const value = resolveImmediate(item.value);
			state.results[item.nodeId] = value;
			state.status[item.nodeId] = "done";
			journal({ at: now(), ev: "node_finished", nodeId: item.nodeId });
		}

		if (batch.halt) {
			halted = batch.halt;
			journal({ at: now(), ev: "halted", reason: batch.halt });
			break;
		}

		if (batch.dispatch.length === 0) {
			if (batch.immediate.length > 0) continue; // progress was made; go again

			// Nothing running, nothing dispatchable, not complete: everything left
			// depends on something that failed. Mark it and finish, rather than
			// spinning.
			const doomed = skippableAfterFailure(options.plan, state);
			if (doomed.length === 0) break;
			for (const nodeId of doomed) state.status[nodeId] = "skipped";
			continue;
		}

		for (const dispatch of batch.dispatch) {
			state.running.add(dispatch.workId);
			journal({ at: now(), ev: "node_started", workId: dispatch.workId, nodeId: dispatch.nodeId });
		}

		const settled = await Promise.all(
			batch.dispatch.map(async (dispatch) => ({
				dispatch,
				result: await runWithRetries(dispatch, options.spawn, options.signal),
			})),
		);

		for (const { dispatch, result } of settled) {
			state.running.delete(dispatch.workId);
			state.agentsSpawned++;
			state.spentTokens += result.tokens;
			state.spentCost += result.cost ?? 0;

			const key = resultKey(dispatch);
			if (result.ok) {
				state.results[key] = result.value;
				state.status[key] = "done";
				if (isTerminalForNode(options.plan, state, dispatch)) state.status[dispatch.nodeId] = "done";
				journal({
					at: now(),
					ev: "node_finished",
					workId: dispatch.workId,
					nodeId: dispatch.nodeId,
					tokens: result.tokens,
					cost: result.cost,
				});
			} else {
				const error = result.error ?? "unknown failure";
				state.status[key] = "failed";
				state.status[dispatch.nodeId] = "failed";
				failures.push({ nodeId: dispatch.nodeId, error });
				journal({ at: now(), ev: "node_failed", workId: dispatch.workId, nodeId: dispatch.nodeId, reason: error });

				const signature = errorSignature(error);
				const count = (failureSignatures.get(signature) ?? 0) + 1;
				failureSignatures.set(signature, count);
				if (count >= IDENTICAL_FAILURE_THRESHOLD) {
					halted = "agents";
					journal({ at: now(), ev: "halted", reason: `identical failure x${count}: ${signature}` });
				}
			}
		}

		if (halted) break;
	}

	// Anything still unstarted after a halt or a failure cascade is `skipped`,
	// never `failed` — it was not tried.
	for (const nodeId of skippableAfterFailure(options.plan, state)) state.status[nodeId] = "skipped";

	journal({ at: now(), ev: "run_finished", tokens: state.spentTokens, cost: state.spentCost });

	return {
		state,
		results: state.results,
		halted,
		failures,
		agentsSpawned: state.agentsSpawned,
		spentTokens: state.spentTokens,
		spentCost: state.spentCost,
	};
}

/** Transforms are computed here rather than in the scheduler, which stays pure. */
function resolveImmediate(value: unknown): unknown {
	if (value && typeof value === "object" && "__transform" in (value as Record<string, unknown>)) {
		const wrapper = value as { __transform: Parameters<typeof applyTransform>[1]; input: unknown };
		return applyTransform(wrapper.input, wrapper.__transform);
	}
	return value;
}

/** Where a dispatch's result is stored — per item and per stage for fanouts/pipelines. */
function resultKey(dispatch: Dispatch): string {
	if (dispatch.stageIndex !== undefined && dispatch.item !== undefined) {
		return `${dispatch.nodeId}#${indexOf(dispatch)}@${dispatch.stageIndex}`;
	}
	if (dispatch.item !== undefined) return `${dispatch.nodeId}#${indexOf(dispatch)}`;
	return dispatch.nodeId;
}

function indexOf(dispatch: Dispatch): number {
	// The scheduler encodes the item index in the work id's first segment via
	// its key; the dispatch carries the item itself, so the index is recovered
	// from the order the scheduler produced. Kept explicit rather than implicit.
	return dispatch.itemIndex ?? 0;
}

/** Is this the last unit of work for its node? */
function isTerminalForNode(plan: Plan, state: RunState, dispatch: Dispatch): boolean {
	const node = plan.nodes.find((candidate) => candidate.id === dispatch.nodeId);
	if (!node) return true;
	return node.kind === "agent";
}

async function runWithRetries(dispatch: Dispatch, spawn: Spawn, signal?: AbortSignal): Promise<WorkerResult> {
	// Capped hard. Claude Code shipped an unbounded retry on exactly this path;
	// a schema a model cannot satisfy is not a schema more attempts will fix.
	const attempts = Math.min(dispatch.retries ?? 2, 3) + 1;
	let last: WorkerResult = { ok: false, value: null, tokens: 0, cost: 0, error: "never ran" };

	for (let attempt = 0; attempt < attempts; attempt++) {
		if (signal?.aborted) return { ...last, error: "aborted" };
		try {
			last = await spawn(dispatch, signal);
		} catch (error) {
			last = { ok: false, value: null, tokens: 0, error: String(error) };
		}
		if (last.ok) return last;
	}
	return last;
}
