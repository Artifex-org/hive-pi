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
		junk: 0,
	};
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

	let event: { type?: string; message?: unknown };
	try {
		event = JSON.parse(line) as { type?: string; message?: unknown };
	} catch {
		return { ...state, junk: state.junk + 1 };
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
