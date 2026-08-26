/**
 * Structured subagent results — schema-validated worker output (HIV-1563).
 *
 * A worker's answer has always been prose: the parent reads
 * `getFinalOutput(messages)` and parses it by eye, or by regex, or not at all.
 * That is survivable for "summarise this" and wrong for anything the caller
 * branches on — and it is what makes mechanical verification heuristic. A typed
 * `{changed_files, tests_run, claim}` lets `harness/verify.ts` check a claim
 * instead of grepping one.
 *
 * The mechanics are constrained by one fact: subagent workers run with
 * `--no-extensions` (see `subagent/worker.ts`), so there is no structured-output
 * TOOL to force inside the worker — the only channel is the text it emits. So:
 * instruct via the appended system prompt, extract a fenced block, validate,
 * and retry once with the validation error. Everything here is pure string and
 * schema work so it tests without spawning a process.
 */

import { Value } from "typebox/value";

/** Retries after the first failed validation. One is the whole budget: a
 *  worker that cannot produce the shape twice is not going to on the third. */
export const MAX_SCHEMA_RETRIES = 1;

/** Validation errors shown back to the worker. Beyond this it stops reading. */
const MAX_REPORTED_ERRORS = 6;

export interface SchemaValidation {
	ok: boolean;
	value?: unknown;
	/** Model-facing, already formatted as a retry instruction. */
	error?: string;
}

/**
 * Schemas we refuse, and why.
 *
 * `additionalProperties: false` is not a style preference — it is the
 * anti-pattern that produced 25 `StructuredOutput` rejections in one Workflow
 * window. A model that adds a `notes` field trips "must NOT have additional
 * properties", and the retry then invents `rootCause2`-style duplicates rather
 * than dropping the extra. The same window taught the second rule: a field
 * documented "empty if none" must be optional, or it fails the opposite way.
 *
 * This refuses rather than warns, deliberately. Guidance at the decision point
 * (technique #4): warnings in tool descriptions are ignored; errors in tool
 * RESULTS are read. The caller is a model, and the moment it can act on this
 * is when its call comes back rejected.
 */
export function rejectUnsupportedSchema(schema: unknown): string | undefined {
	const offenders: string[] = [];
	walk(schema, "", offenders);
	if (offenders.length === 0) return undefined;
	return (
		`This schema sets additionalProperties:false at ${offenders.join(", ")}. ` +
		`Remove it: a closed schema makes a worker's extra field a hard failure, and the ` +
		`retry then invents duplicate field names instead of dropping it. Constrain only ` +
		`the fields you actually branch on, and mark anything documented "empty if none" optional.`
	);
}

function walk(node: unknown, path: string, offenders: string[]): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		node.forEach((item, i) => walk(item, `${path}[${i}]`, offenders));
		return;
	}
	const obj = node as Record<string, unknown>;
	if (obj.additionalProperties === false) offenders.push(path || "(root)");
	for (const [key, value] of Object.entries(obj)) {
		if (key === "additionalProperties") continue;
		walk(value, path ? `${path}.${key}` : key, offenders);
	}
}

/**
 * The instruction appended to the worker's system prompt.
 *
 * Deliberately terse and last-wins: it is concatenated after the role's own
 * prompt, and a long contract competing with the role guide is how typed tools
 * came to be called zero times in the factory (lesson P3).
 */
export function structuredInstruction(schema: unknown): string {
	return [
		"## Required output format",
		"",
		"End your final message with a single fenced JSON block matching this schema:",
		"",
		"```json",
		JSON.stringify(schema, null, 2),
		"```",
		"",
		"Write your normal explanation first, then the block. The block is what the caller reads —",
		"anything you do not put in it is invisible to them. Emit exactly one block, no trailing commentary.",
	].join("\n");
}

/**
 * Pull the result object out of a worker's final message.
 *
 * Last fenced block wins: a worker explaining the schema mid-answer and then
 * emitting the real one is the common shape, and taking the first would read
 * the example. Falls back to parsing the whole output, which is what a worker
 * that took "emit JSON" literally produces.
 */
export function extractJsonBlock(output: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const fenced = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)];
	const candidates = fenced.length > 0 ? fenced.map((m) => m[1]) : [output];
	for (let i = candidates.length - 1; i >= 0; i--) {
		const text = candidates[i].trim();
		if (!text) continue;
		try {
			return { ok: true, value: JSON.parse(text) };
		} catch {
			/* try the next candidate */
		}
	}
	return {
		ok: false,
		error:
			fenced.length > 0
				? "Your fenced JSON block is not valid JSON. Re-emit the block with valid JSON and nothing else inside the fence."
				: "No fenced JSON block found in your answer. End your final message with a single ```json block matching the schema.",
	};
}

/** Validate an extracted value, formatting failures as retry instructions. */
export function validateAgainst(schema: unknown, value: unknown): SchemaValidation {
	// A plain JSON Schema object from a model is structurally what Value.Check
	// consumes; a malformed one throws rather than returning false, and that is
	// the caller's mistake to hear about, not the worker's.
	let ok: boolean;
	try {
		ok = Value.Check(schema as never, value);
	} catch (error) {
		return { ok: false, error: `The schema itself could not be evaluated: ${(error as Error).message}` };
	}
	if (ok) return { ok: true, value };

	// `instancePath` is the JSON Pointer to the offending value ("" at the root).
	// Not `path` — that name typechecks as `any` on a loose union and silently
	// renders every error as "(root)", which is right often enough to look fine.
	const errors = [...Value.Errors(schema as never, value)]
		.slice(0, MAX_REPORTED_ERRORS)
		.map((e) => `  ${e.instancePath || "(root)"}: ${e.message}`);
	return {
		ok: false,
		error: ["Your JSON block does not match the required schema:", ...errors, "", "Re-emit the block, corrected."].join(
			"\n",
		),
	};
}

/** Extract + validate in one step — the whole per-attempt check. */
export function parseStructuredResult(schema: unknown, output: string): SchemaValidation {
	const extracted = extractJsonBlock(output);
	if (!extracted.ok) return { ok: false, error: extracted.error };
	return validateAgainst(schema, extracted.value);
}

/**
 * The follow-up task text for a retry attempt.
 *
 * The worker is a fresh process with no memory of attempt 1, so the retry has
 * to carry both the original task and what went wrong — same reasoning as
 * `distillFailure`'s retry notes, and the same "compact, not summarized" shape.
 */
export function structuredRetryTask(originalTask: string, error: string): string {
	return [
		originalTask,
		"",
		"---",
		"A previous attempt at this exact task produced output that could not be read:",
		"",
		error,
		"",
		"Do the work again and return the required JSON block correctly this time.",
	].join("\n");
}
