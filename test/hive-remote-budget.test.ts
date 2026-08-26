import { describe, expect, it } from "vitest";
import { ARGS_BUDGET, RESULT_BUDGET, budgeted, size } from "../extensions/hive-remote/budget.ts";

// Hive truncates an over-long transcript field on insert. Truncating JSON cuts
// it mid-token, so what lands in the database no longer parses and every
// consumer of the structured payload gets nothing — silently. Everything below
// exists to make sure the payload arrives PARSEABLE, and honest about what it
// had to leave out.

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** A subagent-shaped result: small identifying fields, one enormous one. */
const subagentResult = (messageCount: number) => ({
	content: [{ type: "text", text: "done" }],
	details: {
		mode: "parallel",
		results: [
			{
				agent: "code-reviewer",
				exitCode: 0,
				model: "claude-opus-5",
				usage: { input: 12000, output: 3400 },
				messages: Array.from({ length: messageCount }, (_, i) => ({
					role: "assistant",
					content: `${i} ${"x".repeat(500)}`,
				})),
			},
		],
	},
});

describe("budgeted", () => {
	it("passes a payload under budget through untouched", () => {
		const v = { a: 1, b: "two", c: [3, 4] };
		expect(JSON.parse(budgeted(v, RESULT_BUDGET)!)).toEqual(v);
	});

	it.each([
		["undefined", undefined],
		["null", null],
	])("has nothing to say about %s", (_label, v) => {
		expect(budgeted(v, RESULT_BUDGET)).toBeUndefined();
	});

	// THE bug. Before this, an oversized result reached the database as a string
	// that JSON.parse throws on, and no widget could ever render it.
	it("still parses when the payload is far over budget", () => {
		const out = budgeted(subagentResult(2000), RESULT_BUDGET)!;
		expect(bytes(out)).toBeLessThanOrEqual(RESULT_BUDGET);
		expect(() => JSON.parse(out)).not.toThrow();
	});

	// The small fields of a large payload are the identifying ones. Dropping in
	// arrival order instead would keep whatever came first and lose the rest.
	it("keeps the small identifying fields and sheds the bulk", () => {
		const out = JSON.parse(budgeted(subagentResult(2000), RESULT_BUDGET)!);
		const r = out.details.results[0];
		expect(r.agent).toBe("code-reviewer");
		expect(r.exitCode).toBe(0);
		expect(r.model).toBe("claude-opus-5");
		expect(r.usage).toEqual({ input: 12000, output: 3400 });
	});

	// A reader must be able to see that something is missing, and how much.
	it("says what it dropped, and how big it was", () => {
		const out = budgeted(subagentResult(2000), RESULT_BUDGET)!;
		expect(out).toContain("dropped:");
		expect(out).toMatch(/dropped: [\d.]+ (B|KB|MB)/);
	});

	// An array is usually ordered — a message log, a list of steps — so the
	// beginning plus a count beats an arbitrary sample from the middle.
	it("keeps the head of a long array and counts the tail", () => {
		const out = JSON.parse(budgeted({ items: Array.from({ length: 5000 }, (_, i) => `item-${i} ${"y".repeat(200)}`) }, 8192)!);
		expect(out.items[0]).toContain("item-0");
		expect(String(out.items[out.items.length - 1])).toMatch(/dropped: \d+ more items/);
	});

	it("bounds a bare string result", () => {
		const out = budgeted("z".repeat(RESULT_BUDGET * 2), RESULT_BUDGET)!;
		expect(bytes(out)).toBeLessThanOrEqual(RESULT_BUDGET);
		expect(out).toContain("dropped:");
	});

	// The server's cap is in BYTES; a JS string's length is UTF-16 code units.
	// Budgeting by length would sail past the cap on exactly the transcripts
	// most likely to be near it.
	it("budgets in UTF-8 bytes, not code units", () => {
		const out = budgeted({ text: "漢".repeat(20000) }, 8192)!;
		expect(bytes(out)).toBeLessThanOrEqual(8192);
		expect(() => JSON.parse(out)).not.toThrow();
	});

	it("never splits a multi-byte character", () => {
		const out = budgeted({ text: "🐝".repeat(5000) }, 4096)!;
		// A lone surrogate survives JSON.stringify but is not valid text; the
		// round trip through the parser is what would surface one.
		expect(JSON.parse(out).text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	// This runs inside a pi event handler, where a throw becomes an agent-loop
	// error rather than a logged warning.
	it("degrades rather than throwing on a cycle", () => {
		const cyclic: Record<string, unknown> = { name: "loop" };
		cyclic.self = cyclic;
		expect(() => budgeted(cyclic, RESULT_BUDGET)).not.toThrow();
		expect(budgeted(cyclic, RESULT_BUDGET)).toBe("[unserializable]");
	});

	it("degrades rather than throwing on a BigInt", () => {
		expect(() => budgeted({ n: 1n }, RESULT_BUDGET)).not.toThrow();
	});

	// Pruning re-serializes as it descends, so its cost scales with the payload.
	// Past the hopeless threshold it must stop walking rather than spend tens of
	// megabytes of string work on the agent loop.
	it("refuses to walk an absurd payload, and says so", () => {
		const huge = { blob: "q".repeat(12 * 1024 * 1024) };
		const started = performance.now();
		const out = budgeted(huge, RESULT_BUDGET)!;
		expect(performance.now() - started).toBeLessThan(2000);
		expect(out).toContain("too large to summarize");
		expect(() => JSON.parse(out)).not.toThrow();
	});

	it("honours the smaller argument budget", () => {
		const out = budgeted({ content: "w".repeat(400_000) }, ARGS_BUDGET)!;
		expect(bytes(out)).toBeLessThanOrEqual(ARGS_BUDGET);
	});
});

describe("size", () => {
	it.each([
		[512, "512 B"],
		[2048, "2 KB"],
		[1024 * 1024 * 3, "3.0 MB"],
	])("renders %s bytes as %s", (n, want) => {
		expect(size(n)).toBe(want);
	});
});
