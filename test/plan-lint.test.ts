import { describe, expect, it } from "vitest";
import { lintPlanComposition } from "../extensions/plan/lint.ts";
import { applyOps, emptyPlan } from "../extensions/plan/state.ts";

const now = 1_700_000_000_000;
const lint = (markdown: string) => lintPlanComposition(applyOps(emptyPlan(now), [{ op: "upsert", block: { type: "text", markdown } }], now).doc).map((issue) => issue.kind);

describe("lintPlanComposition", () => {
	it("advises the five supported representations", () => {
		expect(lint("The flow has 3 stages; compare options and verify HIV-2907.")).toEqual(["diagram", "table", "metrics", "checklist", "ticket"]);
	});
	it("recognises asserted quantities, not versions, dates, or step references", () => {
		expect(lint("About 40 callers and 12% of sessions need review.")).toContain("metrics");
		for (const text of ["Bump Node to 24 and re-run the suite.", "The regression landed on 2026-08-27.", "Do step 2 before step 3."]) expect(lint(text)).not.toContain("metrics");
	});
	it("does not mistake encodings and protocols for ticket keys", () => {
		expect(lint("Fix the UTF-8 handling and migrate to HTTP-2.")).not.toContain("ticket");
		expect(lint("Track HIV-2907.")).toContain("ticket");
	});
	it("stays quiet once matching typed blocks are present", () => {
		const doc = applyOps(emptyPlan(now), [
			{ op: "upsert", block: { type: "text", markdown: "The flow has 3 stages; compare options and verify HIV-2907." } },
			{ op: "upsert", block: { type: "diagram", mermaid: "flowchart TD" } }, { op: "upsert", block: { type: "table", columns: ["a"], rows: [["b"]] } },
			{ op: "upsert", block: { type: "metrics", metrics: [{ label: "stages", value: "3" }] } }, { op: "upsert", block: { type: "checklist", items: [{ id: "gate", text: "verify" }] } }, { op: "upsert", block: { type: "ticket", key: "HIV-2907" } },
		], now).doc;
		expect(lintPlanComposition(doc)).toEqual([]);
	});
});

/**
 * Both directions, as a table, because this lint's only real failure mode is
 * crying wolf.
 *
 * The rule it replaces was 180 words of prompt telling the model to show rather
 * than tell, and the measured result was that 43% of plans used no block type
 * but `text` and `steps`. A lint that fires on ordinary sentences fails the same
 * way — an author who sees it on every plan stops reading it — so the QUIET
 * column matters at least as much as the firing one, and each row here is a
 * sentence that was measured misbehaving rather than one imagined.
 */
describe("lintPlanComposition — the quiet column", () => {
	const lintOf = (markdown: string) =>
		lintPlanComposition(applyOps(emptyPlan(now), [{ op: "upsert", block: { type: "text", markdown } }], now).doc)
			.map((issue) => issue.kind);

	it.each([
		["the pipeline has five stages", "The new pipeline has five stages.", "diagram"],
		["a request that flows", "The request flows through the cache.", "diagram"],
		["an arrow", "push → PR → CI → merge.", "diagram"],
		["named verification", "We verify the gate is green.", "checklist"],
		["the tests", "The tests cover the refusal.", "checklist"],
		["a measured share", "12% of sessions carry a duplicate lane.", "metrics"],
		["a ticket key", "This closes HIV-2907.", "ticket"],
	])("fires on %s", (_label, markdown, kind) => {
		expect(lintOf(markdown)).toContain(kind);
	});

	it.each([
		// `call` used to be in the diagram rule; in a plan the word is almost
		// always "call sites", and the nudge it produced was to draw a diagram
		// about a sentence asserting a quantity.
		["call sites", "There are forty call sites to change."],
		// `test(?:ing)?\b` with no LEFT anchor matched the tail of these two.
		["latest", "The latest run was green."],
		["protest", "The protest was peaceful."],
		// The metrics rule once matched any digit at all.
		["a version", "Bump Node to 24."],
		["a date", "It landed on 2026-08-27."],
		// The ticket rule once matched any CAPS-dash-digits token.
		["an encoding", "Fix the UTF-8 handling."],
		["a protocol", "Migrate the client to HTTP-2."],
		["ordinary prose", "Rename the helper and update its callers."],
	])("stays quiet on %s", (_label, markdown) => {
		expect(lintOf(markdown)).toEqual([]);
	});
});
/**
 * The ABSENCE rules — the only two that can fire on a plan with no prose.
 *
 * The mismatch rules above key on prose that already exists, and after they
 * shipped the measured block mix did not move: 44% of 487 plans were still
 * prose-and-checklist only, against a 43% baseline, at 3.0 blocks each. A rule
 * that reads prose cannot ask for prose that is not there, so these key on the
 * plan's SHAPE instead.
 *
 * Both directions again, and the quiet column is the important one: a small
 * plan whose steps ARE the explanation must not be nagged, or the lint loses
 * the reader it needs for the cases that matter.
 */
describe("lintPlanComposition — absence", () => {
	const steps = (count: number) => ({
		op: "upsert" as const,
		block: { type: "steps" as const, steps: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `step ${i}` })) },
	});
	const kindsOf = (...ops: Parameters<typeof applyOps>[1]) => lintPlanComposition(applyOps(emptyPlan(now), ops, now).doc).map((issue) => issue.kind);

	it("asks a stepped plan with no reasoning to say why", () => {
		const kinds = kindsOf(steps(6));
		expect(kinds).toContain("explain");
		expect(kinds).toContain("evidence");
	});

	it("stays quiet on a small plan whose steps are the explanation", () => {
		expect(kindsOf(steps(3))).toEqual([]);
		expect(kindsOf(steps(1))).toEqual([]);
	});

	it("stops asking why once a text block exists", () => {
		const kinds = kindsOf(steps(6), { op: "upsert", block: { type: "text", markdown: "We weighed both routes and took the cheaper one." } });
		expect(kinds).not.toContain("explain");
	});

	it("accepts any one evidence block, not a specific one", () => {
		for (const block of [
			{ type: "diagram" as const, mermaid: "flowchart TD" },
			{ type: "table" as const, columns: ["a"], rows: [["b"]] },
			{ type: "metrics" as const, metrics: [{ label: "n", value: "1" }] },
			{ type: "code" as const, language: "go", code: "func F() {}" },
			{ type: "refs" as const, refs: [{ label: "policy.ts", url: "https://example.invalid/p" }] },
		]) {
			expect(kindsOf(steps(6), { op: "upsert", block })).not.toContain("evidence");
		}
	});

	it("does not count prose or a callout as evidence", () => {
		// The whole point: these are the two blocks the 44% already had.
		const kinds = kindsOf(steps(6), { op: "upsert", block: { type: "callout", tone: "info", markdown: "Mind the gate." } });
		expect(kinds).toContain("evidence");
	});
});
