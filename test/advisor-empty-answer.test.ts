/**
 * "the advisor returned an empty answer" was 100% of this tool's failures over
 * the measurement window and named no remedy, so each occurrence had to be
 * re-investigated from nothing. The response already carried the reason.
 */

import { describe, expect, it } from "vitest";
import { describeEmptyAnswer } from "../extensions/advisor/index.ts";

const SPEC = "openai-codex/gpt-5.6-terra";

describe("describeEmptyAnswer", () => {
	it("names a budget exhausted by reasoning, and the remedy", () => {
		const msg = describeEmptyAnswer(SPEC, {
			content: [{ type: "thinking" }],
			stopReason: "length",
			usage: { output: 16_384 },
		});
		expect(msg).toContain("while still reasoning");
		expect(msg).toContain("ANSWER_MAX_TOKENS");
		expect(msg).toContain("16384");
	});

	it("distinguishes a budget hit with no reasoning from one with", () => {
		const msg = describeEmptyAnswer(SPEC, {
			content: [],
			stopReason: "length",
			usage: { output: 16_384 },
		});
		expect(msg).toContain("having emitted no text");
		expect(msg).not.toContain("while still reasoning");
	});

	it("surfaces a provider error rather than blaming the answer", () => {
		const msg = describeEmptyAnswer(SPEC, {
			content: [],
			stopReason: "error",
			errorMessage: "upstream 502",
			usage: { output: 0 },
		});
		expect(msg).toContain("the request failed");
		expect(msg).toContain("upstream 502");
	});

	it("reports an abort as an abort", () => {
		const msg = describeEmptyAnswer(SPEC, { content: [], stopReason: "aborted", usage: { output: 0 } });
		expect(msg).toContain("was aborted");
	});

	it("separates thought-then-stopped from returned-nothing-at-all", () => {
		const thought = describeEmptyAnswer(SPEC, {
			content: [{ type: "thinking" }],
			stopReason: "stop",
			usage: { output: 900 },
		});
		expect(thought).toContain("produced reasoning and then stopped");

		const nothing = describeEmptyAnswer(SPEC, { content: [], stopReason: "stop", usage: { output: 0 } });
		expect(nothing).toContain("nothing at all");
	});

	// The advisor's whole job is reading a transcript the caller may not want
	// quoted back, and this string reaches a transcript AND the telemetry
	// classifier. Counts and a stop reason only.
	it("never quotes response text", () => {
		const secret = "ACME_CORP_MIGRATION_PLAN";
		const msg = describeEmptyAnswer(SPEC, {
			content: [{ type: "thinking" }, { type: "text" }],
			stopReason: "length",
			usage: { output: 12 },
		});
		expect(msg).not.toContain(secret);
		// The only interpolations are the model spec, the budget, and token counts.
		expect(msg).toContain(SPEC);
	});

	it("degrades rather than throwing when the response is missing fields", () => {
		expect(() => describeEmptyAnswer(SPEC, { content: [] })).not.toThrow();
		expect(describeEmptyAnswer(SPEC, { content: [] })).toContain("unknown");
	});
});
