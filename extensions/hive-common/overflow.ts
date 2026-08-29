/**
 * Is this session wedged against its own context window? — pure, so the two
 * callers that must not wake a dead session can ask without a `ctx`.
 *
 * MEASURED, 2026-08-29, over 875 local transcripts. A grok-4.6 session whose
 * context reaches the provider's hard prompt limit does not fail once and stop.
 * It fails, and then keeps being woken:
 *
 *     04:30:12  custom:team-message
 *     04:30:14  assistant/error   400 "maximum prompt length is 500000 but the
 *                                      request contains 501356 tokens"
 *     04:32:42  custom:background
 *     04:32:44  assistant/error   … 501608 tokens
 *     04:42:00  custom:team-message
 *     04:42:01  assistant/error   … 501836 tokens
 *
 * Every one of those errors is preceded, one to two seconds earlier, by an
 * injection from this harness. The worst case ran **12 h 27 m** and 11 identical
 * refusals; across the corpus, 7 of 112 grok sessions died this way and 15.5
 * hours were spent on requests that could never be sent.
 *
 * `agenda/turn-outcome.ts` already states the doctrine and enforces it for the
 * driver: a turn that never reached the provider is not evidence, so re-driving
 * it is "the definition of a burn loop". The two injectors below predate that
 * rule and bypass the driver entirely, because they call `pi.sendMessage(…,
 * {triggerTurn: true})` directly:
 *
 *   - `hive-remote`'s `team_message`
 *   - `background`'s completion `notify`
 *
 * This module is the predicate they were missing. It is deliberately NARROWER
 * than `turnFailureOf`: that one suppresses on ANY error, which is right for a
 * policy chain that can simply run again later, and wrong here — a transient
 * WebSocket blip must not stop a teammate's message from ever landing. Only an
 * overflow is unrecoverable by waiting, because the request grows with every
 * attempt and the next one is therefore strictly worse than the last.
 */

/**
 * The provider strings that mean "your prompt does not fit".
 *
 * MIRRORED from pi's own `OVERFLOW_PATTERNS` rather than imported: they live in
 * `../ai/src/utils/overflow.ts` inside the compiled binary and are not part of
 * the extension API. Mirroring a list we do not own is a liability, so this copy
 * is deliberately the SHORT one — the handful of shapes actually observed on
 * this fleet plus the two generic ones — instead of pi's full twenty-four. A
 * pattern we fail to match costs a missed suppression, which is the behaviour we
 * have today; a pattern that over-matches would silence real messages.
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
	/maximum prompt length is \d+/i,
	/exceeds the context window/i,
	/prompt is too long/i,
	/context[_ ]length[_ ]exceeded/i,
	/maximum context length is \d+ tokens/i,
	/request_too_large/i,
];

/** True when a provider error message says the prompt did not fit. */
export function isContextOverflowText(text: unknown): boolean {
	if (typeof text !== "string" || text === "") return false;
	return OVERFLOW_PATTERNS.some((p) => p.test(text));
}

interface BranchEntry {
	message?: {
		role?: string;
		stopReason?: unknown;
		errorMessage?: unknown;
		error?: unknown;
	};
}

/**
 * How many of the NEWEST consecutive assistant turns failed on overflow.
 *
 * Zero means the last thing the model did was reach the provider, whatever else
 * went wrong — so the session is worth waking.
 *
 * Counts backwards over assistant turns only, ignoring the tool results and
 * custom entries between them: an injection lands between two assistant turns,
 * and a run broken by a `custom:team-message` is still an unbroken run of
 * refusals as far as the provider is concerned. Stops at the first assistant
 * turn that is not an overflow, so a session that recovers is immediately
 * wakeable again and nothing stays suppressed on old evidence — the same
 * "newest turn only" rule `turnFailureOf` documents.
 */
export function overflowRunLength(branch: readonly unknown[]): number {
	let run = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = (branch[i] as BranchEntry | undefined)?.message;
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error") return run;
		const text = message.errorMessage ?? message.error;
		if (!isContextOverflowText(typeof text === "string" ? text : JSON.stringify(text ?? ""))) return run;
		run++;
	}
	return run;
}

/**
 * Should this harness wake the session?
 *
 * ONE refusal is enough. pi retries a failed turn itself (`retry.maxRetries`,
 * 3 on this fleet), so by the time an overflow error is the newest assistant
 * turn the provider has already refused it repeatedly. Waiting for a second
 * before suppressing would buy nothing and cost another round trip.
 */
export function isOverflowWedged(branch: readonly unknown[]): boolean {
	return overflowRunLength(branch) > 0;
}
