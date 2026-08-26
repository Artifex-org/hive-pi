/**
 * Failure distillation (HIV-1232) — pure extraction, pinned wording for the
 * red-vs-red comparison the conductor's verify stage leans on.
 */

import { describe, expect, it } from "vitest";
import { compareFailures, distillFailure } from "../extensions/harness/distill.ts";

describe("distillFailure", () => {
	it("keeps the attempted line, classifies, and extracts deduplicated error lines", () => {
		const note = distillFailure({
			attempted: "npm run check\nsecond line is dropped",
			output: [
				"info: starting",
				"Error: cannot resolve module './x'",
				"some noise",
				"Error: cannot resolve module './x'",
				"FAIL test/a.test.ts",
				"2 tests failed",
			].join("\n"),
		});
		expect(note).toContain("attempted: npm run check");
		expect(note).not.toContain("second line");
		expect(note).toContain("class: test-failure");
		// Deduplicated: the repeated resolve error appears once.
		expect(note.match(/cannot resolve module/g)).toHaveLength(1);
		expect(note).toContain("FAIL test/a.test.ts");
	});

	it("classifies timeouts and aborts ahead of content", () => {
		expect(distillFailure({ attempted: "x", output: "whatever", timedOut: true })).toContain("class: timeout");
		expect(distillFailure({ attempted: "x", output: "", stopReason: "aborted" })).toContain("class: aborted");
	});

	it("falls back to the output tail when nothing looks like an error line", () => {
		const note = distillFailure({ attempted: "x", output: "line one\nline two\nfinal summary" });
		expect(note).toContain("output tail:");
		expect(note).toContain("final summary");
	});

	it("caps the note", () => {
		const note = distillFailure({ attempted: "x", output: "Error: boom\n".repeat(500) });
		expect(note.length).toBeLessThanOrEqual(1200);
	});
});

describe("compareFailures", () => {
	it("calls out an identical failure as no observable progress", () => {
		expect(compareFailures("same", "same")).toContain("IDENTICAL to the previous attempt");
	});

	it("quotes the previous note when the failure moved", () => {
		const text = compareFailures("old failure", "new failure");
		expect(text).toContain("you are making progress");
		expect(text).toContain("old failure");
	});
});
