/**
 * The one thing standing between an unvalidated answer and a caller who thinks
 * it was validated.
 *
 * `runAgentWithSchema` spends its retry budget and then returns a SUCCESSFUL
 * result that still carries `structuredError`. Every consumer checks
 * `isFailedResult`, which is false — so if this rendering is silent, the step
 * passes as if its schema had been met.
 *
 * That mattered concretely in chain mode: without the marker, step 2's
 * `{previous}` was prose with no sign the contract had broken, and the chain's
 * final answer read as validated. It is marked rather than fatal there because
 * `{previous}` is consumed by a MODEL, which can adapt to "unvalidated" but not
 * to something it is never told — unlike the agenda side, where `resolveRef`
 * reads fields off the value and gets `undefined` in silence.
 */

import { describe, expect, it } from "vitest";

import { type SingleResult, structuredSection } from "../extensions/subagent/index.ts";

function result(overrides: Partial<SingleResult>): SingleResult {
	return {
		agent: "research",
		agentSource: "user",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

describe("structuredSection", () => {
	it("says nothing at all when no schema was asked for", () => {
		// Schemaless chains and single calls must be byte-identical to before.
		expect(structuredSection(result({}))).toBe("");
	});

	it("renders the validated object so the caller can use it directly", () => {
		const section = structuredSection(result({ structured: { findings: ["a"] } }));
		expect(section).toContain("validated against your schema");
		expect(section).toContain('"findings"');
	});

	it("SAYS SO when the schema was never satisfied — an exit-0 result that failed its contract", () => {
		const section = structuredSection(result({ structuredError: "missing required property 'findings'" }));
		expect(section).toContain("Schema NOT satisfied");
		expect(section).toContain("treat the prose above as unvalidated");
		expect(section).toContain("missing required property 'findings'");
	});

	it("prefers the value over the error if a result somehow carries both", () => {
		// Defensive: a validated answer is the stronger fact, and reporting both
		// would read as a contradiction.
		const section = structuredSection(result({ structured: { ok: true }, structuredError: "stale" }));
		expect(section).toContain("validated against your schema");
		expect(section).not.toContain("NOT satisfied");
	});
});
