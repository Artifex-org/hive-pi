/**
 * Did the last turn actually RUN? — pure, so it is testable without a session.
 *
 * `verdict.ts` already states this principle for the EVALUATOR: an unparseable
 * answer is an error, never `ok:false`, because a judge that crashed has told us
 * nothing about the goal, and reading that as "condition not met" spends an
 * iteration and injects a continuation on a fabricated premise.
 *
 * The same principle was never applied one level up, to the turn being judged.
 * `agent_settled` fires whether the turn produced work, was cancelled by the
 * human, or never reached the provider at all — and the driver ran the policy
 * chain on all three.
 *
 * Observed cost of that gap (session 019fd3bc, 2026-08-05): a Ctrl+C landed
 * mid-tool-call and left the transcript with a `function_call_output` whose
 * `function_call` was gone. Every later turn was refused by the provider —
 *
 *     Codex error: No tool call found for function call output with call_id …
 *
 * — and since a refused turn appends no evidence, the evaluator kept truthfully
 * answering "not met" and the driver kept injecting. **Eight identical failures
 * plus eight evaluator calls**, against a transcript no continuation could ever
 * repair, until the cap ran out.
 *
 * So both outcomes below skip the chain entirely — no ledger charge, no
 * injection:
 *
 *   `error`   the turn produced no evidence about anything. Retrying an
 *             identical prompt against an identical transcript is the
 *             definition of a burn loop.
 *   `aborted` the HUMAN stopped it. Auto-continuing is not merely wasteful,
 *             it overrides an explicit instruction to stop.
 *
 * Neither cancels the goal. The goal stays armed for the next real turn, which
 * is what the human gets to decide.
 */

/** Why the last turn is not evidence. `undefined` means it ran normally. */
export type TurnFailure = "error" | "aborted";

/** `stopReason` values that mean "this turn is not evidence about the goal". */
const FAILURE_REASONS = new Set<string>(["error", "aborted"]);

/**
 * Read the newest assistant turn's outcome off a session branch.
 *
 * Takes the branch array rather than a `ctx` so it is pure. The driver already
 * calls `ctx.sessionManager.getBranch()` for the transcript, so this costs no
 * extra read and no extra timing risk.
 *
 * Scans backwards to the FIRST assistant message and stops. Only the newest
 * turn is relevant: an error five turns ago that the human has since worked
 * past must not keep the loop suppressed forever.
 */
export function turnFailureOf(branch: readonly unknown[]): TurnFailure | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { message?: { role?: string; stopReason?: unknown } } | undefined;
		const message = entry?.message;
		if (message?.role !== "assistant") continue;

		const reason = message.stopReason;
		if (typeof reason === "string" && FAILURE_REASONS.has(reason)) return reason as TurnFailure;
		return undefined;
	}
	return undefined;
}
