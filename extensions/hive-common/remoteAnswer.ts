/**
 * hive-common — waiting for an answer that may arrive from the browser.
 *
 * `ask_user_question` and `plan_ask` both stop the agent to ask a human. Until
 * HIV-1765 the only human who could reply was one sitting at the terminal the
 * agent runs in, which for a Hive-launched session is nobody by construction:
 * the operator drives it from a browser tab, and the pane is unattended.
 *
 * The two tools resolve that differently — `ask` opens a blocking overlay,
 * `plan_ask` returns its question as text — so what they share is not a control
 * flow but a subscription: *is there an answer for THIS call id, and did it
 * arrive before something else settled the question*. That is what lives here,
 * pure and without a pi dependency, so both can be tested without a TUI.
 */

import type { QuestionAnswerEvent } from "./channels.ts";

/**
 * Anything with pi's event-bus shape, narrowed to what a waiter uses.
 *
 * `on` returns its own unsubscribe — that is pi's contract, and it is the only
 * way to detach here: the bus has no `off`.
 */
export interface AnswerBus {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

export type Answers = Record<string, string[]>;

/**
 * The single key a `plan_ask` answer is filed under.
 *
 * `plan_ask` asks one question and mints no id for it, so client and server have
 * to agree on a constant — Hive's browser form asserts the same string. A silent
 * disagreement would deliver an answer the waiting tool cannot find, which is
 * indistinguishable from never answering at all.
 */
export const PLAN_ASK_KEY = "answer";

/** How long `plan_ask` waits for a browser answer before giving up on one.
 *
 * Bounded because an unbounded wait is the failure this feature is not allowed
 * to reintroduce (HIV-1449: 68 minutes at a prompt nobody could see). On elapse
 * the tool returns its question as text, exactly as it always did — the operator
 * reads it in the transcript and replies in their own time. */
export const PLAN_ASK_WAIT_MS = 10 * 60_000;

/**
 * Validate an inbound answer event. Everything is re-checked on arrival: the
 * payload crossed a network, a database and a JSON round trip since the operator
 * clicked, and a malformed one must be ignored rather than resolve a tool with
 * garbage.
 */
export function answerFor(callID: string, data: unknown): Answers | null {
	const event = data as QuestionAnswerEvent | undefined;
	if (!event || typeof event !== "object") return null;
	if (typeof event.callID !== "string" || event.callID !== callID) return null;
	const raw = event.answers;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

	const out: Answers = {};
	for (const [id, values] of Object.entries(raw)) {
		if (typeof id !== "string" || id === "") continue;
		if (!Array.isArray(values)) continue;
		const clean = values.filter((v): v is string => typeof v === "string" && v !== "");
		if (clean.length > 0) out[id] = clean;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * A live subscription to the answer for one tool call.
 *
 * `dispose` is not optional politeness — a tool that returned while its
 * subscription stayed attached would keep a closure (and its overlay's `done`)
 * alive for the rest of the session, and a later answer to a recycled call id
 * would fire it. Every caller disposes in a `finally`.
 */
export interface AnswerWaiter {
	/** Resolves with the first valid answer for this call, or never. */
	readonly answered: Promise<Answers>;
	dispose(): void;
}

export function waitForAnswer(bus: AnswerBus, channel: string, callID: string): AnswerWaiter {
	let settled = false;
	let resolve!: (a: Answers) => void;
	const answered = new Promise<Answers>((r) => {
		resolve = r;
	});
	const handler = (data: unknown) => {
		if (settled) return;
		const answers = answerFor(callID, data);
		if (!answers) return;
		settled = true;
		resolve(answers);
	};
	const unsubscribe = bus.on(channel, handler);
	return {
		answered,
		dispose() {
			settled = true;
			unsubscribe?.();
		},
	};
}
