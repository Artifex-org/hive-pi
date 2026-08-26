/**
 * brief — parsing the worker's answer and rendering it (HIV-1798).
 *
 * The parse tests are adversarial on purpose: the input is a cheap model's
 * stdout, and every "tolerant" branch here is one a real one has taken. The
 * rule the suite enforces is that tolerance stops at the shape — anything we
 * cannot turn into a draft returns null so the caller falls through to the
 * untouched prompt, because a half-parsed brief is how invented facts get in.
 */

import { describe, expect, it } from "vitest";
import { compileBrief, draftIsEmpty, estimateTokens, parseBriefDraft, type BriefDraft } from "../extensions/brief/compile.ts";

const FULL = {
	goal: "Make placement testable by extracting the scoring fold.",
	facts: [{ ref: "internal/scheduler/place.go:88", note: "scoring is inline in the dispatch loop" }],
	start_here: [{ ref: "internal/scheduler/place.go", reason: "holds the fold to extract" }],
	refs: [{ ref: "KB infrastructure/cicd/hive.md", note: "scheduler overview" }],
	unknowns: ["whether capacity scores are persisted anywhere"],
	next_moves: ["grep for placement_score across internal/"],
};

function draft(overrides: Partial<BriefDraft> = {}): BriefDraft {
	return {
		goal: FULL.goal,
		facts: [{ ref: FULL.facts[0]!.ref, note: FULL.facts[0]!.note }],
		startHere: [{ ref: FULL.start_here[0]!.ref, reason: FULL.start_here[0]!.reason }],
		refs: [{ ref: FULL.refs[0]!.ref, note: FULL.refs[0]!.note }],
		unknowns: [...FULL.unknowns],
		nextMoves: [...FULL.next_moves],
		history: [],
		...overrides,
	};
}

describe("parseBriefDraft", () => {
	it("parses a fenced object", () => {
		const parsed = parseBriefDraft("```json\n" + JSON.stringify(FULL) + "\n```");
		expect(parsed?.goal).toBe(FULL.goal);
		expect(parsed?.facts).toEqual([{ ref: "internal/scheduler/place.go:88", note: "scoring is inline in the dispatch loop" }]);
		expect(parsed?.startHere).toEqual([{ ref: "internal/scheduler/place.go", reason: "holds the fold to extract" }]);
		expect(parsed?.nextMoves).toEqual(FULL.next_moves);
	});

	it("takes the LAST fence, so a quoted example does not win", () => {
		const example = JSON.stringify({ goal: "EXAMPLE FROM MY INSTRUCTIONS" });
		const text = "Here is the shape I was asked for:\n```json\n" + example + "\n```\nAnd my answer:\n```json\n" + JSON.stringify(FULL) + "\n```";
		expect(parseBriefDraft(text)?.goal).toBe(FULL.goal);
	});

	it("falls back to an unfenced object", () => {
		expect(parseBriefDraft(`sure thing! ${JSON.stringify(FULL)}`)?.goal).toBe(FULL.goal);
	});

	it("returns null on prose with no object", () => {
		expect(parseBriefDraft("I looked around and could not find anything relevant.")).toBeNull();
	});

	it("returns null on malformed json rather than guessing", () => {
		expect(parseBriefDraft("```json\n{ goal: 'unquoted' \n```")).toBeNull();
	});

	it("returns null on a json array — the contract is an object", () => {
		expect(parseBriefDraft("```json\n[1,2,3]\n```")).toBeNull();
	});

	it("drops entries with no usable ref instead of rendering an empty bullet", () => {
		const parsed = parseBriefDraft(
			"```json\n" + JSON.stringify({ facts: [{ note: "no ref" }, { ref: "  ", note: "blank" }, { ref: "a.ts:1", note: "kept" }] }) + "\n```",
		);
		expect(parsed?.facts).toEqual([{ ref: "a.ts:1", note: "kept" }]);
	});

	it("survives missing and wrong-typed fields", () => {
		const parsed = parseBriefDraft("```json\n" + JSON.stringify({ goal: 42, facts: "nope" }) + "\n```");
		expect(parsed).toEqual({ goal: "", facts: [], startHere: [], refs: [], unknowns: [], nextMoves: [], history: [] });
	});

	it("caps a padded list at the number the role was given", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ ref: `f${i}.ts:1`, note: "x" }));
		expect(parseBriefDraft("```json\n" + JSON.stringify({ facts: many }) + "\n```")?.facts).toHaveLength(8);
	});
});

describe("draftIsEmpty", () => {
	it("is true when the worker found nothing", () => {
		expect(draftIsEmpty({ goal: "", facts: [], startHere: [], refs: [], unknowns: [], nextMoves: [], history: [] })).toBe(true);
	});

	it("is false when it found only a goal", () => {
		expect(draftIsEmpty({ goal: "x", facts: [], startHere: [], refs: [], unknowns: [], nextMoves: [], history: [] })).toBe(false);
	});
});

describe("compileBrief", () => {
	const input = {
		original: "make the scheduler placement testable",
		draft: draft(),
		budgetTokens: 2000,
		includeOriginal: true,
		model: "cheap/model",
		elapsedMs: 1234,
	};

	it("stamps a marker that suppression can recognise", () => {
		const { text } = compileBrief(input);
		expect(text.startsWith("<!-- brief:v1 model=cheap/model elapsed_ms=1234 -->")).toBe(true);
	});

	it("keeps the original verbatim when it becomes the prompt", () => {
		expect(compileBrief(input).text).toContain("make the scheduler placement testable");
	});

	it("omits the original when the brief only accompanies it", () => {
		const { text } = compileBrief({ ...input, includeOriginal: false });
		expect(text).not.toContain("## Task, as given");
		expect(text).toContain(FULL.goal);
	});

	it("frames start-here as fallible, and gives every entry its reason", () => {
		const { text } = compileBrief(input);
		expect(text).toContain("it can be wrong");
		expect(text).toContain("holds the fold to extract");
	});

	it("renders no empty section for an absent list", () => {
		const { text } = compileBrief({ ...input, draft: draft({ refs: [], unknowns: [] }) });
		expect(text).not.toContain("## Related material");
		expect(text).not.toContain("## Not determined");
	});

	it("reports what it produced", () => {
		const { report } = compileBrief(input);
		expect(report.dropped).toEqual([]);
		expect(report.sections.map((s) => s.name)).toEqual(["goal", "task", "facts", "start_here", "unknowns", "next_moves", "refs"]);
		expect(report.tokens).toBeGreaterThan(0);
	});

	it("drops the lowest-value sections first when the budget binds", () => {
		const { text, report } = compileBrief({ ...input, budgetTokens: 40 });
		// refs before next_moves before unknowns — the reverse of how much a model
		// would miss them.
		expect(report.dropped.slice(0, 3)).toEqual(["refs", "next_moves", "unknowns"]);
		expect(text).toContain(FULL.goal);
	});

	it("never drops the goal or the verbatim task, even over budget", () => {
		const { text, report } = compileBrief({ ...input, budgetTokens: 1 });
		expect(report.dropped).not.toContain("goal");
		expect(report.dropped).not.toContain("task");
		expect(text).toContain("make the scheduler placement testable");
		expect(report.tokens).toBeGreaterThan(1); // shipped over budget, and says so
	});

	it("drops whole sections, never half a list", () => {
		const facts = Array.from({ length: 8 }, (_, i) => ({ ref: `f${i}.ts:1`, note: "a reasonably long note about this file" }));
		const { text, report } = compileBrief({ ...input, draft: draft({ facts }), budgetTokens: 60 });
		if (report.dropped.includes("facts")) expect(text).not.toContain("f0.ts:1");
		else for (const f of facts) expect(text).toContain(f.ref);
	});
});

describe("estimateTokens", () => {
	it("is zero for empty and roughly chars/4 otherwise", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});
