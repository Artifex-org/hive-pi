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
	/** Workers admitted, retries INCLUDED — a retried dispatch is not one agent. */
	agentsSpawned: number;
	spentTokens: number;
	/** Dollars for the whole run. */
	spentCost: number;
	/**
	 * Nodes the run finished without ever scheduling, in plan order.
	 *
	 * Absent — like `halted` — on the healthy run, so its presence is the signal.
	 * Under a halt these are the nodes the halt cut off; with no halt they are a
	 * DEFECT: the scheduler had no work to produce for a node the validator let
	 * through. Those also appear in `failures`, because that is what the tool's
	 * summary text prints and a silently omitted node is the failure mode this
	 * field exists to end.
	 */
	neverRan?: string[];
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
			// ADMISSIONS, not dispatches. `maxAgents` is a cap on workers spawned,
			// and a retried dispatch spawns up to four of them; counting it once
			// let a plan run 4x past its own agent cap without the scheduler ever
			// seeing it. `result.tokens` is likewise the whole sequence's spend.
			state.agentsSpawned += result.attempts;
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
					attempts: result.attempts,
					tokens: result.tokens,
					cost: result.cost,
				});
			} else {
				const error = result.error ?? "unknown failure";
				state.status[key] = "failed";
				state.status[dispatch.nodeId] = "failed";
				failures.push({ nodeId: dispatch.nodeId, error });
				// `attempts` is carried on both outcomes: three workers behind one
				// "node failed" line is the difference between a cheap failure and
				// an expensive one, and the journal is where that is legible.
				journal({
					at: now(),
					ev: "node_failed",
					workId: dispatch.workId,
					nodeId: dispatch.nodeId,
					attempts: result.attempts,
					reason: error,
				});

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

	// ...and that used to be only HALF of what the sentence above claims. A node
	// the scheduler produced no work for reached here with NO status at all, and
	// the run then reported `halted: undefined, failures: []` and a results map
	// that simply lacked it. Measured on a three-node plan (agent → repeat →
	// barrier): one worker ran, the repeat and its downstream barrier were never
	// instantiated, never marked, never mentioned — a successful-looking run that
	// executed a third of the plan. `validatePlan` now refuses the known cause
	// (`repeat`), but the hole is general: any future kind the scheduler cannot
	// schedule would vanish the same way, which is exactly the class of bug that
	// stays hidden the longest.
	const neverRan = options.plan.nodes.filter((node) => state.status[node.id] === undefined).map((node) => node.id);
	for (const nodeId of neverRan) state.status[nodeId] = "skipped";

	// Under a halt this is expected and already explained — the summary prints
	// the halt reason and its caps, and adding a failure line per unrun node
	// would bury it. With NO halt there is nothing else to read: the run ended
	// believing it was finished, so the failure channel is the only surface that
	// makes the drop visible where a reader is already looking.
	if (!halted && neverRan.length > 0) {
		for (const nodeId of neverRan) {
			failures.push({
				nodeId,
				error:
					`never ran: the run ended with no work dispatched for this node (${neverRan.length} node(s) never ran: ` +
					`${neverRan.join(", ")}). The scheduler has no branch for its kind, or nothing ever satisfied it.`,
			});
		}
	}

	journal({ at: now(), ev: "run_finished", tokens: state.spentTokens, cost: state.spentCost });

	return {
		state,
		results: state.results,
		halted,
		failures,
		agentsSpawned: state.agentsSpawned,
		spentTokens: state.spentTokens,
		spentCost: state.spentCost,
		...(neverRan.length > 0 ? { neverRan } : {}),
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

/** A dispatch's verdict, plus what the whole retry sequence actually cost. */
interface AttemptedResult extends WorkerResult {
	/** How many workers were really spawned — 1 when nothing had to be retried. */
	attempts: number;
}

/**
 * Run one dispatch, retrying on failure, and report the WHOLE sequence's spend.
 *
 * Each attempt is a real worker with a real bill. This used to return only the
 * last attempt's result, and the caller then added that one result's tokens and
 * counted exactly one admission — so a node with `retries: 3` could spawn four
 * workers and surface as `agentsSpawned: 1, spentTokens: 5000` (measured, at
 * 5000 tokens per spawn). Both hard caps in `nextBatch` are folds over those two
 * counters, so neither could see three quarters of the run: a concrete route to
 * a 50k-token budget consuming 101k, which the documented one-worker overshoot
 * bound does not explain. The verdict is still the last attempt's — a retry that
 * finally succeeds succeeded — but the money is the sum.
 */
async function runWithRetries(dispatch: Dispatch, spawn: Spawn, signal?: AbortSignal): Promise<AttemptedResult> {
	// Capped hard. Claude Code shipped an unbounded retry on exactly this path;
	// a schema a model cannot satisfy is not a schema more attempts will fix.
	const maxAttempts = Math.min(dispatch.retries ?? 2, 3) + 1;
	let last: WorkerResult = { ok: false, value: null, tokens: 0, cost: 0, error: "never ran" };
	let tokens = 0;
	// Left undefined until some attempt observes a cost, per `WorkerResult.cost`:
	// a spawner that cannot see dollars must not be reported as having spent $0.
	let cost: number | undefined;
	let attempts = 0;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		// An abort between attempts still owes the caller the spend of the
		// attempts that DID run — dropping it here would hide a whole wave.
		if (signal?.aborted) return { ...last, tokens, cost, attempts, error: "aborted" };
		attempts++;
		try {
			last = await spawn(dispatch, signal);
		} catch (error) {
			// A throw is a worker that started and died; it was still admitted, so
			// it still counts as an attempt. Its tokens are simply unknown.
			last = { ok: false, value: null, tokens: 0, error: String(error) };
		}
		tokens += last.tokens;
		if (last.cost !== undefined) cost = (cost ?? 0) + last.cost;
		if (last.ok) return { ...last, tokens, cost, attempts };
	}
	return { ...last, tokens, cost, attempts };
}
