/**
 * Parsing the evaluator's answer — pure, no I/O.
 *
 * The single most important property here: **an unparseable answer is an
 * ERROR, never `ok:false`.**
 *
 * Those two look identical to a naive parser and are opposite in consequence. A
 * judge that returned prose, or crashed, or hit its timeout, has told us
 * *nothing* about the goal. Reading that as "condition not met" spends an
 * iteration, injects a continuation, and hands the model a fabricated reason to
 * act on. Repeated a few times it burns the whole budget on a goal that may
 * well have been achieved on turn one.
 *
 * So the return type is a three-way, and the caller must handle `error`
 * distinctly: judge errors increment their own counter and never inject.
 *
 * `pending` is the SAME PRINCIPLE applied one step further out, and it was
 * added because the binary answer was costing more than the judge errors ever
 * did. Measured over 688 goals to 2026-08-29: **256 capped against 191
 * achieved**, and the capped ones always ran the budget out — median 8
 * iterations of a maximum 8. Two thirds of them (171) capped while the work the
 * condition names was STILL IN FLIGHT, the judge answering, truthfully:
 *
 *     "Run #2663 for PR #3584 is still running: 1 of 10 tasks succeeded,
 *      9 pending — not all required checks are green yet."
 *
 * That is not "the condition is unmet". It is "the condition cannot be
 * evaluated yet", and spending an iteration on it means an agent correctly
 * waiting on a 40-minute CI run exhausts its whole budget waiting — 28.3M
 * evaluator tokens went into capped goals against 7.8M into achieved ones.
 *
 * The existing `noProgressStreak` convergence check does not catch it, and
 * cannot: it trips on three IDENTICAL reasons, while a pending reason names
 * live counts ("1 of 10 succeeded") that change on every poll.
 */

export interface Verdict {
	ok: boolean;
	reason: string;
	/**
	 * The condition names work that has not finished, so there is nothing to
	 * grade yet. Optional on the wire and absent means false, so an older
	 * evaluator answer keeps its exact meaning.
	 */
	pending?: boolean;
}

export type VerdictResult = { kind: "verdict"; verdict: Verdict } | { kind: "error"; message: string };

/** Longest raw answer we will even attempt to parse. */
const MAX_ANSWER_CHARS = 64 * 1024;

/**
 * Pull a JSON object out of the model's answer.
 *
 * Accepts a bare object or a single fenced block, because instruction-following
 * on small models is imperfect and a ```json fence is the most common
 * deviation. Anything looser — two objects, an object buried in commentary —
 * is refused rather than guessed at: picking one of two candidates is exactly
 * the kind of silent wrong answer this module exists to prevent.
 */
function extractJsonObject(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
	const candidate = (fence ? fence[1] : trimmed).trim();

	if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;
	return candidate;
}

export function parseVerdict(raw: string): VerdictResult {
	if (raw.length > MAX_ANSWER_CHARS) {
		return { kind: "error", message: `evaluator answer too large (${raw.length} chars)` };
	}

	const candidate = extractJsonObject(raw);
	if (candidate === null) {
		const preview = raw.trim().slice(0, 120).replace(/\s+/g, " ");
		return { kind: "error", message: `evaluator did not return a JSON object: "${preview}"` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch (error) {
		return { kind: "error", message: `evaluator returned invalid JSON: ${String(error)}` };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "error", message: "evaluator returned JSON that is not an object" };
	}

	const record = parsed as Record<string, unknown>;

	// STRICT on `ok`. A string "true" is a formatting failure, and coercing it
	// would mean a judge that cannot follow the schema still gets to decide
	// whether the goal is done.
	if (typeof record.ok !== "boolean") {
		return {
			kind: "error",
			message: `evaluator "ok" must be a boolean, got ${JSON.stringify(record.ok)}`,
		};
	}

	// `reason` is required in BOTH directions. On `ok:false` it is the steering
	// text fed to the next turn, and on `ok:true` it is the record of why the
	// goal was closed — a goal that completes with no stated reason is
	// indistinguishable from a judge that rubber-stamped it.
	if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
		return { kind: "error", message: "evaluator omitted a non-empty \"reason\"" };
	}

	// LENIENT on `pending`, where `ok` is strict, and the asymmetry is the point:
	// `ok` decides whether the goal closes, so a judge that cannot express it
	// must not be guessed at. `pending` only decides whether an iteration is
	// SPENT, and reading a malformed one as absent costs exactly what today
	// costs — an iteration — rather than risking a goal that never terminates.
	const pending = record.pending === true;

	// `ok:true` wins. A judge that says both has contradicted itself, and the
	// safe reading is the one that TERMINATES: treating it as pending would keep
	// re-grading a goal the judge has already said is met.
	// Set only when TRUE, so an ordinary verdict keeps the exact shape it has
	// always had. `pending: false` on every answer would be the same information
	// and a different object, and every existing caller compares whole verdicts.
	const verdict: Verdict = { ok: record.ok, reason: record.reason.trim() };
	if (pending && !record.ok) verdict.pending = true;
	return { kind: "verdict", verdict };
}
