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
 */

export interface Verdict {
	ok: boolean;
	reason: string;
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

	return { kind: "verdict", verdict: { ok: record.ok, reason: record.reason.trim() } };
}
