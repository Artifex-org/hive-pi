/**
 * Compaction re-arm of Hive's Detail-rail recap.
 *
 * The fetch itself is a thin MCP call and is not exercised here — that would
 * need a live Hive. What these pin is the SHAPE the compact path injects, so a
 * recap_session payload change that would leave the model with nothing after
 * compaction fails here instead of in a long session.
 */

import { describe, expect, it } from "vitest";

import { COMPACT_PRESERVE, compactInstructions, formatSessionRecap } from "../extensions/agenda/session-recap.ts";

describe("formatSessionRecap", () => {
	it("prefers stay_on lines — the same fold the MCP tool already computed", () => {
		const got = formatSessionRecap(
			JSON.stringify({
				recap: "adding recap_session",
				stay_on: ["adding recap_session", "branch feature/x · PR #12", "plan 1/3 execute"],
			}),
		);
		expect(got).toContain("Session recap (restored after compaction):");
		expect(got).toContain("- adding recap_session");
		expect(got).toContain("feature/x");
		expect(got).toContain("PR #12");
	});

	it("falls back to the one-line recap when stay_on is empty", () => {
		const got = formatSessionRecap(JSON.stringify({ recap: "waiting on CI" }));
		expect(got).toBe("Session recap (restored after compaction): waiting on CI");
	});

	it("falls back to the title when even the recap is missing", () => {
		const got = formatSessionRecap(JSON.stringify({ title: "fix the flaky test" }));
		expect(got).toBe("Session recap (restored after compaction): fix the flaky test");
	});

	it("returns null on empty or unreadable bodies so a failed fetch injects nothing", () => {
		expect(formatSessionRecap("")).toBeNull();
		expect(formatSessionRecap("{")).toBeNull();
		expect(formatSessionRecap("{}")).toBeNull();
	});

	it("passes through a body that is already the injected prose", () => {
		const prose = "Session recap (restored after compaction): already folded";
		expect(formatSessionRecap(prose)).toBe(prose);
	});
});

describe("compactInstructions", () => {
	it("always keeps the Detail-rail preserve clause", () => {
		expect(compactInstructions()).toBe(COMPACT_PRESERVE);
		expect(compactInstructions("keep the failing test name")).toContain("keep the failing test name");
		expect(compactInstructions("keep the failing test name")).toContain("recap_session");
	});
});
