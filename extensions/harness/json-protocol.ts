/**
 * The `pi --mode json` event fold — pure, so every guarantee is testable
 * without a child process.
 *
 * `agenda` got this treatment for `--mode rpc` (`rpc-protocol.ts`) and it paid:
 * the split-chunk loss, the user-message double-count and the reply-drain hang
 * all have tests that need no subprocess. The `--mode json` side stayed inline
 * in `subagent/index.ts` inside a `proc.stdout.on("data")` closure, where the
 * only way to exercise it was to spawn a real worker — which is why the things
 * it gets wrong were found by reading rather than by failing.
 *
 * Two rules this encodes, both learned the expensive way:
 *
 *   1. **`message_end` fires for the USER message too.** Treating every
 *      `message_end` as the worker's output makes an empty run return the
 *      caller's own prompt as a successful answer. (Found by running the Aurora
 *      sidecar; `tsc` had no opinion.)
 *   2. **`usage.cost` is an object.** Reading it any other way books a paid run
 *      as free, silently. `harness/usage.ts` owns that read.
 *
 * `contextTokens` is ASSIGNED, not accumulated: it is a running snapshot of the
 * live context window, so summing it across turns produces a number that grows
 * without bound and means nothing.
 */

import { addUsage, emptyUsage, type Usage, type WireUsage } from "./usage.ts";

/** The subset of a pi assistant message this fold reads. */
interface WireMessage {
	role?: string;
	content?: unknown;
	usage?: WireUsage & { totalTokens?: number };
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

/**
 * What pi spent retrying a RETRYABLE provider error, from the newest retry
 * sequence (`auto_retry_start` / `auto_retry_end`).
 *
 * This is the only place the attempts are countable. pi classifies a 429 as
 * retryable and burns its whole budget with exponential backoff BEFORE the
 * caller sees anything, then surfaces one raw string — so a caller told merely
 * "failed" cannot tell a first-attempt refusal from three attempts over 14s,
 * and re-issues immediately into the same limit.
 */
export interface WorkerRetries {
	/** Attempts started in the newest sequence. */
	attempts: number;
	/** The budget pi was working against. */
	maxAttempts: number;
	/** Total backoff waited across those attempts — SUMMED, not the last delay. */
	waitedMs: number;
	/** True when a retry finally landed; false when the budget ran out. */
	succeeded?: boolean;
}

export interface JsonRunState {
	/** Every message, in arrival order — the caller renders these. */
	messages: unknown[];
	usage: Usage;
	/** Completed assistant turns. */
	turns: number;
	/** Live context-window size as of the last assistant message. */
	contextTokens: number;
	/** First model that actually answered, which may differ from the request. */
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Pi's own retry accounting, when it retried at all. */
	retries?: WorkerRetries;
	/** Lines that were not JSON. Counted, not kept — a raw dump is not a diagnostic. */
	junk: number;
}

export function emptyJsonRunState(): JsonRunState {
	return {
		messages: [],
		usage: emptyUsage(),
		turns: 0,
		contextTokens: 0,
		model: undefined,
		stopReason: undefined,
		errorMessage: undefined,
		retries: undefined,
		junk: 0,
	};
}

/** A number off the wire, or a stated fallback — never `NaN` in a note. */
function wireNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Fold one line of a child's stdout into run state. Returns a NEW state.
 *
 * Unknown event types are ignored rather than rejected: pi adds events between
 * versions, and a worker that dies on an unrecognised line is a worker that dies
 * on the next pi bump.
 */
export function foldJsonLine(state: JsonRunState, line: string): JsonRunState {
	if (!line.trim()) return state;

	let event: {
		type?: string;
		message?: unknown;
		attempt?: unknown;
		maxAttempts?: unknown;
		delayMs?: unknown;
		success?: unknown;
	};
	try {
		event = JSON.parse(line) as typeof event;
	} catch {
		return { ...state, junk: state.junk + 1 };
	}

	// Pi resets its retry counter after a retry lands, so a second sequence in one
	// run starts at attempt 1 again. Restart the accumulator there rather than
	// summing two unrelated sequences into one inflated wait.
	if (event.type === "auto_retry_start") {
		const attempt = wireNumber(event.attempt, 0);
		const previous = attempt > 1 ? state.retries : undefined;
		return {
			...state,
			retries: {
				attempts: attempt,
				maxAttempts: wireNumber(event.maxAttempts, previous?.maxAttempts ?? attempt),
				waitedMs: (previous?.waitedMs ?? 0) + wireNumber(event.delayMs, 0),
				succeeded: undefined,
			},
		};
	}
	if (event.type === "auto_retry_end") {
		// pi only ends a sequence it started; without a start there is nothing to
		// account for, and a new object here would emit a UI update saying nothing.
		if (!state.retries) return state;
		return { ...state, retries: { ...state.retries, succeeded: event.success === true } };
	}

	if (event.type !== "message_end" || !event.message) return state;

	const message = event.message as WireMessage;
	const messages = [...state.messages, event.message];

	// Rule 1: only the assistant's messages are the worker's output or spend.
	if (message.role !== "assistant") return { ...state, messages };

	return {
		...state,
		messages,
		turns: state.turns + 1,
		usage: addUsage(state.usage, message.usage),
		// Assigned, not summed — see the header.
		contextTokens: message.usage?.totalTokens ?? state.contextTokens,
		// FIRST model wins: a fallback later in the run should not overwrite the
		// record of what actually answered first.
		model: state.model ?? message.model,
		stopReason: message.stopReason ?? state.stopReason,
		errorMessage: message.errorMessage ?? state.errorMessage,
	};
}
