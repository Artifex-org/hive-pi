/**
 * `/goal` argument grammar.
 *
 * The case that matters most is the one that is easy to get wrong: a subcommand
 * keyword only counts when it is the WHOLE argument. `/goal stop the nightly
 * sync from double-running` is a goal, and treating it as a stop silently
 * discards the user's condition.
 */

import { describe, expect, it } from "vitest";
import {
	looksUnverifiable,
	parseGoalCommand,
	parseHours,
	parseTokenCount,
} from "../extensions/agenda/goal-command.ts";
import { MAX_CONDITION_CHARS } from "../extensions/agenda/goal-state.ts";

describe("parseGoalCommand — subcommands", () => {
	it("bare /goal is a status request", () => {
		expect(parseGoalCommand("")).toEqual({ kind: "status" });
		expect(parseGoalCommand("   ")).toEqual({ kind: "status" });
	});

	it.each(["clear", "stop", "off", "none", "cancel", "reset"])("%s clears", (word) => {
		expect(parseGoalCommand(word)).toEqual({ kind: "clear" });
	});

	it("is case-insensitive about them", () => {
		expect(parseGoalCommand("CLEAR")).toEqual({ kind: "clear" });
	});

	it("pause and resume", () => {
		expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
		expect(parseGoalCommand("resume")).toEqual({ kind: "resume" });
	});

	it("treats a keyword followed by more words as a CONDITION, not a subcommand", () => {
		const parsed = parseGoalCommand("stop the nightly sync from double-running");
		expect(parsed).toEqual({ kind: "set", condition: "stop the nightly sync from double-running" });
	});

	it("likewise for a condition that merely starts with 'clear'", () => {
		expect(parseGoalCommand("clear the backlog of failing tests")).toMatchObject({ kind: "set" });
	});
});

describe("parseGoalCommand — setting", () => {
	it("takes the whole remainder as the condition", () => {
		expect(parseGoalCommand("pytest -q exits 0")).toEqual({ kind: "set", condition: "pytest -q exits 0" });
	});

	it("preserves internal formatting", () => {
		const condition = "tests pass AND the diff touches only tests/";
		expect(parseGoalCommand(condition)).toEqual({ kind: "set", condition });
	});

	it("refuses an over-long condition and says by how much", () => {
		const parsed = parseGoalCommand("x".repeat(MAX_CONDITION_CHARS + 1));
		expect(parsed.kind).toBe("error");
		expect((parsed as { message: string }).message).toContain(String(MAX_CONDITION_CHARS + 1));
	});

	it("accepts one exactly at the limit", () => {
		expect(parseGoalCommand("x".repeat(MAX_CONDITION_CHARS)).kind).toBe("set");
	});
});

describe("parseGoalCommand — budget flags", () => {
	it("--tokens with a k suffix", () => {
		expect(parseGoalCommand("--tokens 200k build is green")).toEqual({
			kind: "set",
			condition: "build is green",
			budget: { tokens: 200_000 },
		});
	});

	it("--hours", () => {
		expect(parseGoalCommand("--hours 4 build is green")).toEqual({
			kind: "set",
			condition: "build is green",
			budget: { wallClockMs: 4 * 3_600_000 },
		});
	});

	it("both together", () => {
		const parsed = parseGoalCommand("--tokens 50k --hours 2 ship it");
		expect(parsed).toMatchObject({ kind: "set", budget: { tokens: 50_000, wallClockMs: 7_200_000 } });
	});

	it("omits the budget key entirely when no flag was given", () => {
		expect(parseGoalCommand("just do it")).not.toHaveProperty("budget");
	});

	it("errors on a flag with no condition after it", () => {
		expect(parseGoalCommand("--tokens 200k")).toMatchObject({ kind: "error" });
	});

	it("errors on a flag with no value", () => {
		expect(parseGoalCommand("--tokens")).toMatchObject({ kind: "error" });
	});

	it("errors on an unparseable value rather than silently ignoring the budget", () => {
		const parsed = parseGoalCommand("--tokens lots of them");
		expect(parsed.kind).toBe("error");
		expect((parsed as { message: string }).message).toContain("lots");
	});

	it("errors on an unknown flag and names the supported ones", () => {
		const parsed = parseGoalCommand("--forever do the thing");
		expect(parsed.kind).toBe("error");
		expect((parsed as { message: string }).message).toContain("--tokens");
	});

	it("does not treat a mid-condition double dash as a flag", () => {
		expect(parseGoalCommand("run the script -- then verify")).toMatchObject({ kind: "set" });
	});
});

describe("parseTokenCount", () => {
	it.each([
		["200k", 200_000],
		["1.5m", 1_500_000],
		["50000", 50_000],
		["1K", 1_000],
	])("%s → %i", (raw, expected) => {
		expect(parseTokenCount(raw)).toBe(expected);
	});

	it.each(["", "abc", "-5", "0", "20g", "1.2.3"])("rejects %s", (raw) => {
		expect(parseTokenCount(raw)).toBeNull();
	});
});

describe("parseHours", () => {
	it("accepts fractions", () => {
		expect(parseHours("0.5")).toBe(1_800_000);
	});

	it.each(["", "abc", "-1", "0"])("rejects %s", (raw) => {
		expect(parseHours(raw)).toBeNull();
	});
});

describe("looksUnverifiable — advisory only", () => {
	it.each([
		"pytest -q exits 0",
		"the build is green",
		"all tests pass",
		"`npm run check` succeeds",
		"src/index.ts compiles",
		"0 errors remain",
	])("recognises a checkable condition: %s", (condition) => {
		expect(looksUnverifiable(condition)).toBe(false);
	});

	it.each(["make the code better", "improve performance", "tidy things up"])(
		"flags an ungradeable one: %s",
		(condition) => {
			expect(looksUnverifiable(condition)).toBe(true);
		},
	);
});
