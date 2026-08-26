/**
 * brief — configuration (HIV-1798).
 *
 * Env-driven, like advisor's: the feature is on by default and must work on a
 * machine that configured nothing, so every knob has a working default and
 * there is no config file to go stale. The `/brief off` command writes
 * `PI_BRIEF_AUTO` for the process, not to disk — a session-scoped opt-out is
 * what an operator actually wants when one prompt is being enriched badly, and
 * a persisted one is a footgun nobody remembers setting.
 */

export interface BriefConfig {
	/** Kill switch: registers nothing at all. */
	disabled: boolean;
	/** Fire automatically on the first task-like prompt. `/brief` still works when off. */
	auto: boolean;
	/** `provider/id` override for the briefer worker. Otherwise the role's own pin. */
	model: string | undefined;
	/**
	 * Hard wall for ONE LANE of the retrieval pass.
	 *
	 * Per lane, not per pass (HIV-1804): the lanes run concurrently, so the pass
	 * ends when its slowest lane does and this number bounds that lane rather
	 * than their sum. A lane that hits the wall costs only its own findings —
	 * the merge ships whatever the others established.
	 *
	 * This BLOCKS the agent's first turn by design — a brief that lands after
	 * the model has started reading files has already lost. So the number is a
	 * direct latency cost, and it is set from measurement rather than taste. Two
	 * real SEQUENTIAL passes over this repo on the fleet's low tier: **72.5s** (7
	 * facts, 3 candidates, 3 unknowns) and **49.5s** through the extension end to
	 * end. The spread is the point — the first draft of this file said 60s, which
	 * sits between the two, and would have timed out on its own smoke test.
	 *
	 * Lower it and briefs stop arriving; raise it and every session's first turn
	 * waits longer. If that trade goes the wrong way the answer is not a bigger
	 * number, it is `PI_BRIEF_AUTO=0` plus `/brief` on demand.
	 */
	timeoutMs: number;
	/** Token budget for the rendered brief. Sections drop by priority above it. */
	budgetTokens: number;
	/**
	 * Drop the verbatim original from the rendered brief, leaving only the
	 * tightened goal. OFF by default: a cheap model silently losing the user's
	 * intent is the one new failure this feature can introduce, and keeping the
	 * original costs tokens where replacing it costs the task.
	 */
	replace: boolean;
	/** Prompts shorter than this are never task-like enough to be worth a worker. */
	minPromptChars: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BUDGET_TOKENS = 2_000;
const DEFAULT_MIN_PROMPT_CHARS = 40;

export function loadBriefConfig(env: NodeJS.ProcessEnv = process.env): BriefConfig {
	return {
		disabled: env.PI_BRIEF_DISABLED === "1",
		auto: env.PI_BRIEF_AUTO !== "0",
		model: nonEmpty(env.PI_BRIEF_MODEL),
		timeoutMs: positiveInt(env.PI_BRIEF_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
		budgetTokens: positiveInt(env.PI_BRIEF_BUDGET_TOKENS) ?? DEFAULT_BUDGET_TOKENS,
		replace: env.PI_BRIEF_REPLACE === "1",
		minPromptChars: positiveInt(env.PI_BRIEF_MIN_CHARS) ?? DEFAULT_MIN_PROMPT_CHARS,
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
