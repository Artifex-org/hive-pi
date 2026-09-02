/**
 * Is this session out of provider allowance? — pure, so every caller that must
 * decide "can this session still send a request" can ask without a `ctx`.
 *
 * THE FAILURE. A live session holds ONE model. When its provider's allowance
 * runs out, every turn fails before it reaches the model, and nothing in Hive
 * says so: `live_state` stays `active`, the pane stays alive, the heartbeat
 * beats, and `diagnose_agent_session` has answered "nothing wrong found" for a
 * session in exactly this state (HIV-1926). The error text exists ONLY in the
 * terminal. On 2026-08-15 five agents froze this way simultaneously; on
 * 2026-09-02 the same shape walked an operator through three providers in one
 * afternoon — grok out of credits, codex at its 7-day quota, then the OpenRouter
 * key's weekly limit.
 *
 * WHY THIS IS A SEPARATE PREDICATE FROM `overflow.ts`. The two failures look
 * identical from outside — a run of `assistant/error` turns — and have opposite
 * remedies. An overflow is fixed by making the request SMALLER (compact), and
 * the same provider will then serve it. Exhaustion is not fixed by anything the
 * session can do to its own context: the allowance is gone until it resets, so
 * the only way forward is a different account or a different provider. Merging
 * them would send each case the other's remedy.
 *
 * A THIRD CLASS DELIBERATELY EXCLUDED: auth failure (401, expired refresh
 * token). It also produces an unbroken run of failed turns, and it is also
 * unrecoverable by waiting — but its remedy is `pi auth`, not a model switch,
 * and switching provider on an auth failure would abandon a perfectly funded
 * account because its token needed refreshing. HIV-1926 asks for exactly this
 * separation: `auth_expired` vs `quota_exhausted` vs transport.
 */

/**
 * The provider strings that mean "you have no allowance left".
 *
 * MEASURED, not guessed — every pattern below is here because a provider on
 * this fleet actually emitted it (dates in the comments). The list is
 * deliberately SHORT, the same trade `OVERFLOW_PATTERNS` documents: a pattern we
 * fail to match costs a missed failover, which is the behaviour we have today
 * and which an operator can still fix by hand; a pattern that over-matches
 * migrates a healthy session off a working provider, which is a new failure this
 * module would have invented.
 *
 * That asymmetry is why none of these is a bare word. `"credits"` alone would
 * match "the credits page explains billing" in a tool result quoted back in an
 * error; `"limit"` alone matches rate limits, which recover by waiting.
 */
const QUOTA_PATTERNS: readonly RegExp[] = [
	// Codex, 7-day quota at 100% (2026-09-02, HIV-3235). Also OpenAI's
	// `insufficient_quota` error code, same account state, different wrapper.
	/usage limit (?:has been )?reached/i,
	/you'?ve hit your usage limit/i,
	/insufficient_quota/i,
	// xAI, credential out of credits (2026-08-26 and 2026-09-02): a hard 403
	// that does not recover until someone buys credits.
	/run out of credits/i,
	/need a grok subscription/i,
	// OpenRouter key limits — the 402 that froze five pyERP agents on
	// 2026-08-15 (daily) and stranded a smoke agent on 2026-09-02 (weekly).
	// `limit_source` is the field OpenRouter puts the cause in, and it is the
	// most specific thing in the body.
	/limit_source"?\s*:\s*"?openrouter_key_limit/i,
	/requires more credits, or fewer max_tokens/i,
	// Generic, across providers. Anchored on the two-word phrase rather than
	// "quota" alone so a tool result mentioning a quota cannot trip it.
	/quota exceeded/i,
	/exceeded your current quota/i,
	/billing (?:hard )?limit reached/i,
];

/**
 * Auth failures, which this module must NOT report as exhaustion.
 *
 * Checked FIRST and as a veto: some providers phrase an expired credential in
 * words that brush against the allowance patterns above ("your subscription
 * could not be verified"), and getting this backwards means a session migrates
 * off a funded account whose token merely needed refreshing. When both match,
 * auth wins — it is the more specific diagnosis and the cheaper mistake.
 */
const AUTH_PATTERNS: readonly RegExp[] = [
	/refresh token/i,
	/token (?:has )?expired/i,
	/invalid[_ ]api[_ ]key/i,
	/unauthorized/i,
	/401/,
	/re-?authenticate/i,
	/please (?:run )?`?pi auth`?/i,
];

/** True when a provider error says the credential is bad rather than drained. */
export function isAuthFailureText(text: unknown): boolean {
	if (typeof text !== "string" || text === "") return false;
	return AUTH_PATTERNS.some((p) => p.test(text));
}

/**
 * True when a provider error message says the allowance is gone.
 *
 * False for an auth failure even when an allowance pattern also matches — see
 * AUTH_PATTERNS. False for a transient (429 rate limit, 5xx, transport): those
 * recover by waiting, and failing a session over to another provider on a blip
 * would abandon its account for no reason.
 */
export function isQuotaExhaustedText(text: unknown): boolean {
	if (typeof text !== "string" || text === "") return false;
	if (isAuthFailureText(text)) return false;
	return QUOTA_PATTERNS.some((p) => p.test(text));
}

interface BranchEntry {
	message?: {
		role?: string;
		stopReason?: unknown;
		errorMessage?: unknown;
		error?: unknown;
	};
}

/** The error text of one branch entry, however the build wrapped it. */
function errorTextOf(message: BranchEntry["message"]): string {
	const text = message?.errorMessage ?? message?.error;
	return typeof text === "string" ? text : JSON.stringify(text ?? "");
}

/**
 * How many of the NEWEST consecutive assistant turns failed on exhaustion.
 *
 * Zero means the last thing the model did was reach the provider, whatever else
 * went wrong — so nothing here should fire.
 *
 * Counts backwards over assistant turns only, ignoring tool results and custom
 * entries between them: an injection lands between two assistant turns, and a
 * run broken by a `custom:team-message` is still an unbroken run of refusals as
 * far as the provider is concerned. Stops at the first assistant turn that is
 * not an exhaustion, so a session that recovers is immediately healthy again and
 * nothing stays latched on old evidence — the same "newest turn only" rule
 * `overflowRunLength` and `turnFailureOf` both apply.
 */
export function quotaRunLength(branch: readonly unknown[]): number {
	let run = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = (branch[i] as BranchEntry | undefined)?.message;
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error") return run;
		if (!isQuotaExhaustedText(errorTextOf(message))) return run;
		run++;
	}
	return run;
}

/**
 * Should this session fail over to another provider?
 *
 * ONE refusal is enough, for the same reason `isOverflowWedged` accepts one: pi
 * retries a failed turn itself (`retry.maxRetries`, 3 on this fleet), so by the
 * time an exhaustion error is the newest assistant turn the provider has already
 * refused it repeatedly. Waiting for a second costs another dead round trip and
 * buys no certainty — the allowance does not come back within a turn.
 */
export function isQuotaExhausted(branch: readonly unknown[]): boolean {
	return quotaRunLength(branch) > 0;
}

/**
 * Why the newest assistant turn failed, as the three classes whose remedies
 * differ — HIV-1926's ask #2.
 *
 * `null` when the newest assistant turn did not fail, which is the common case
 * and must stay distinguishable from "failed for a reason we do not recognise":
 * the latter is `"other"`, and reporting it as healthy is how a whole class of
 * provider failure stayed invisible.
 */
export type TurnFailureClass = "quota_exhausted" | "auth_expired" | "other";

export function newestTurnFailure(branch: readonly unknown[]): TurnFailureClass | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = (branch[i] as BranchEntry | undefined)?.message;
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error") return null;
		const text = errorTextOf(message);
		if (isAuthFailureText(text)) return "auth_expired";
		if (isQuotaExhaustedText(text)) return "quota_exhausted";
		return "other";
	}
	return null;
}
