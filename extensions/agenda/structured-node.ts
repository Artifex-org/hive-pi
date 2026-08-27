/**
 * `outputSchema` on a plan node — enforced, having been decorative.
 *
 * The plan language has advertised `outputSchema` on every agent spec since the
 * orchestrator shipped. `plan-graph.ts` threads it through three call sites into
 * `Dispatch.outputSchema`, and `executor.ts`'s `WorkerResult.value` documents
 * itself as *"Parsed structured output when the node asked for a schema, else
 * raw text"*.
 *
 * Nothing read it. Neither `worker.ts` nor `rpc-worker.ts` ever mentioned the
 * field, and both returned `result.text` unconditionally. A plan author could
 * write a schema, watch the run go green, and get prose — with a comment in our
 * own source claiming otherwise.
 *
 * That has a consequence beyond ergonomics, and it is the reason this is worth
 * fixing rather than deleting: `resolveRef("<node>.<field>")` walks a path into
 * a node's result. On a string it returns `undefined` for every field. So
 * `needs`, `over` and the `pluck`/`sortBy`/`groupBy` transforms could not
 * address anything a worker produced — the typed half of the plan language was
 * unreachable, silently.
 *
 * The decision is pure and lives here; the spawning stays in the two workers.
 */

import {
	MAX_SCHEMA_RETRIES,
	parseStructuredResult,
	rejectUnsupportedSchema,
	structuredInstruction,
	structuredRetryTask,
} from "../harness/structured.ts";

export type NodeOutcome =
	/** No schema asked for, or one satisfied. `value` is prose or the typed object. */
	| { kind: "value"; value: unknown }
	/** Ask the same role again, with the validation error in the prompt. */
	| { kind: "retry"; prompt: string }
	/** Out of retries, or a retry would be unsafe. The node fails. */
	| { kind: "fail"; error: string };

/**
 * The prompt a schema-carrying node should actually be given.
 *
 * Appended to the node prompt rather than the role's system prompt: a role is
 * shared by every node that names it, and one node's shape is not the role's
 * contract. `subagent/index.ts` appends to the system prompt instead because
 * there the schema IS per-invocation — same idea, different seam.
 */
export function nodePrompt(prompt: string, schema: unknown): string {
	if (!schema) return prompt;
	return `${prompt}\n\n${structuredInstruction(schema)}`;
}

/**
 * What to do with a worker's text, given the node's schema.
 *
 * `writerCapable` is not a style preference. A writer that returned the wrong
 * SHAPE has already changed the tree; re-running it is a second mutation
 * attempt wearing a formatting fix's clothes, and the re-run would then fold to
 * NO_CHANGE_ERROR against its own completed work. `subagent/index.ts` reached
 * the same conclusion for the same reason — the rule is repeated here because
 * the two spawners are still separate.
 */
export function judgeOutput(
	schema: unknown,
	text: string,
	options: { attempt: number; originalPrompt: string; writerCapable: boolean },
): NodeOutcome {
	if (!schema) return { kind: "value", value: text };

	const unsupported = rejectUnsupportedSchema(schema);
	if (unsupported) return { kind: "fail", error: `unusable outputSchema: ${unsupported}` };

	const parsed = parseStructuredResult(schema, text);
	if (parsed.ok) return { kind: "value", value: parsed.value };

	// `SchemaValidation.error` is optional, and an unexplained rejection is the
	// worst thing to hand a retry — it would re-run the worker with a blank
	// reason and burn the budget learning nothing.
	const why = parsed.error ?? "the output did not match the schema, and the validator gave no detail";

	if (options.writerCapable) {
		return { kind: "fail", error: `worker did not satisfy outputSchema: ${why}` };
	}
	if (options.attempt >= MAX_SCHEMA_RETRIES) {
		return { kind: "fail", error: `worker did not satisfy outputSchema after ${options.attempt + 1} attempts: ${why}` };
	}
	return { kind: "retry", prompt: nodePrompt(structuredRetryTask(options.originalPrompt, why), schema) };
}

/**
 * Drive a schema-carrying node to a typed value, or to a clean failure.
 *
 * `run` is the caller's "spawn this role with this prompt and give me its
 * text", so this stays independent of one-shot vs durable workers — the two
 * differ in how they spawn, not in what a schema means.
 *
 * Failing is deliberate rather than degrading to prose. A node that asked for a
 * shape and got something else must not hand a string to a dependent that will
 * silently read `undefined` off it; that is the failure this whole change is
 * about, one level down.
 */
export async function resolveNodeOutput(
	schema: unknown,
	originalPrompt: string,
	writerCapable: boolean,
	run: (prompt: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	let prompt = nodePrompt(originalPrompt, schema);
	for (let attempt = 0; ; attempt++) {
		const result = await run(prompt);
		if (!result.ok) return { ok: false, error: result.error };

		const outcome = judgeOutput(schema, result.text, { attempt, originalPrompt, writerCapable });
		if (outcome.kind === "value") return { ok: true, value: outcome.value };
		if (outcome.kind === "fail") return { ok: false, error: outcome.error };
		prompt = outcome.prompt;
	}
}
