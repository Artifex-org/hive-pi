/**
 * `outputSchema` on a plan node, now that something reads it.
 *
 * The field was threaded from the plan language through `plan-graph.ts` into
 * `Dispatch.outputSchema` and then consumed by nobody — while `WorkerResult`'s
 * own comment claimed `value` was "parsed structured output when the node asked
 * for a schema". These tests are what make that comment true, and what stops it
 * quietly reverting.
 */

import { describe, expect, it } from "vitest";

import { judgeOutput, nodePrompt, resolveNodeOutput } from "../extensions/agenda/structured-node.ts";

const SCHEMA = {
	type: "object",
	properties: { findings: { type: "array" }, done: { type: "boolean" } },
	required: ["findings"],
};

const block = (value: unknown) => `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("nodePrompt", () => {
	it("leaves a schemaless prompt untouched", () => {
		expect(nodePrompt("do the thing", undefined)).toBe("do the thing");
	});

	it("appends the schema contract to the NODE prompt, not the role", () => {
		// A role is shared by every node naming it; one node's shape is not the
		// role's contract.
		const prompt = nodePrompt("do the thing", SCHEMA);
		expect(prompt.startsWith("do the thing")).toBe(true);
		expect(prompt).toContain("findings");
	});
});

describe("judgeOutput", () => {
	it("passes prose straight through when no schema was asked for", () => {
		expect(judgeOutput(undefined, "just prose", { attempt: 0, originalPrompt: "p", writerCapable: false })).toEqual({
			kind: "value",
			value: "just prose",
		});
	});

	it("returns the parsed object, not the text around it", () => {
		const outcome = judgeOutput(SCHEMA, block({ findings: ["a"], done: true }), {
			attempt: 0,
			originalPrompt: "p",
			writerCapable: false,
		});
		expect(outcome).toEqual({ kind: "value", value: { findings: ["a"], done: true } });
	});

	it("retries a READER once, carrying the validation error into the prompt", () => {
		const outcome = judgeOutput(SCHEMA, "no json here at all", { attempt: 0, originalPrompt: "find things", writerCapable: false });
		expect(outcome.kind).toBe("retry");
		if (outcome.kind !== "retry") return;
		expect(outcome.prompt).toContain("find things");
		// The retry must still state the schema, or attempt 2 is a blind re-roll.
		expect(outcome.prompt).toContain("findings");
	});

	it("never retries a WRITER — it has already changed the tree", () => {
		// A re-run would be a second mutation dressed as a formatting fix, and it
		// would then fold to NO_CHANGE_ERROR against its own completed work.
		const outcome = judgeOutput(SCHEMA, "no json", { attempt: 0, originalPrompt: "p", writerCapable: true });
		expect(outcome.kind).toBe("fail");
	});

	it("gives up once the retry budget is spent, rather than looping", () => {
		const outcome = judgeOutput(SCHEMA, "still no json", { attempt: 1, originalPrompt: "p", writerCapable: false });
		expect(outcome.kind).toBe("fail");
		if (outcome.kind !== "fail") return;
		expect(outcome.error).toContain("2 attempts");
	});

	it("refuses a schema it cannot use, instead of failing the worker for it", () => {
		const outcome = judgeOutput({ type: "object", additionalProperties: false }, block({ findings: [] }), {
			attempt: 0,
			originalPrompt: "p",
			writerCapable: false,
		});
		expect(outcome.kind).toBe("fail");
		if (outcome.kind !== "fail") return;
		expect(outcome.error).toContain("unusable outputSchema");
	});

	it("always says WHY, even when the validator offers no detail", () => {
		// A retry prompt with a blank reason burns the budget teaching nothing.
		const outcome = judgeOutput(SCHEMA, "", { attempt: 1, originalPrompt: "p", writerCapable: false });
		expect(outcome.kind).toBe("fail");
		if (outcome.kind !== "fail") return;
		expect(outcome.error.trim().endsWith(":")).toBe(false);
		expect(outcome.error.length).toBeGreaterThan("worker did not satisfy outputSchema after 2 attempts: ".length);
	});
});

describe("resolveNodeOutput", () => {
	it("returns the typed value on the first good answer, spawning once", async () => {
		const prompts: string[] = [];
		const result = await resolveNodeOutput(SCHEMA, "find things", false, async (prompt) => {
			prompts.push(prompt);
			return { ok: true, text: block({ findings: ["x"] }) };
		});
		expect(result).toEqual({ ok: true, value: { findings: ["x"] } });
		expect(prompts).toHaveLength(1);
	});

	it("re-runs once with the error, and keeps the second answer", async () => {
		const prompts: string[] = [];
		const result = await resolveNodeOutput(SCHEMA, "find things", false, async (prompt) => {
			prompts.push(prompt);
			return prompts.length === 1 ? { ok: true, text: "prose only" } : { ok: true, text: block({ findings: ["y"] }) };
		});
		expect(result).toEqual({ ok: true, value: { findings: ["y"] } });
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("A previous attempt");
	});

	it("FAILS the node rather than handing prose to a dependent", async () => {
		// The whole reason for this change: `resolveRef("node.field")` reads
		// `undefined` off a string, so a degraded-to-prose result would make every
		// downstream ref silently empty.
		const result = await resolveNodeOutput(SCHEMA, "p", false, async () => ({ ok: true, text: "never json" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("outputSchema");
	});

	it("propagates a spawn failure unchanged, without spending a schema retry", async () => {
		let calls = 0;
		const result = await resolveNodeOutput(SCHEMA, "p", false, async () => {
			calls++;
			return { ok: false, error: "worker timed out" };
		});
		expect(result).toEqual({ ok: false, error: "worker timed out" });
		expect(calls).toBe(1);
	});

	it("is a pass-through when the node declared no schema", async () => {
		const result = await resolveNodeOutput(undefined, "p", false, async () => ({ ok: true, text: "prose" }));
		expect(result).toEqual({ ok: true, value: "prose" });
	});
});
