import { describe, expect, it } from "vitest";
import {
	citationWarning,
	missingCitedPaths,
	NO_CHANGE_ERROR,
	writerMadeNoChange,
} from "../extensions/harness/verify.ts";

describe("writerMadeNoChange", () => {
	it("identical stamps mean no change", () => {
		expect(writerMadeNoChange(" M a.ts\n", " M a.ts\n")).toBe(true);
	});

	it("differing stamps mean a change happened", () => {
		expect(writerMadeNoChange("", " M a.ts\n")).toBe(false);
	});

	it("a stamp that could not be taken DISABLES the check", () => {
		// A verifier that could not run must never report as one that ran and
		// failed — the gate's bashAvailable rule, applied here.
		expect(writerMadeNoChange(null, "x")).toBe(false);
		expect(writerMadeNoChange("x", null)).toBe(false);
	});
});

describe("missingCitedPaths", () => {
	const cwd = process.cwd();

	it("passes real paths and flags invented ones", () => {
		const text =
			"Changed extensions/agenda/driver.ts:42 and consulted extensions/agenda/no-such-module.ts for the fold.";
		const missing = missingCitedPaths(text, cwd);
		expect(missing).toContain("extensions/agenda/no-such-module.ts");
		expect(missing).not.toContain("extensions/agenda/driver.ts");
	});

	it("reports each invented path once", () => {
		const text = "See src/fake/one.ts and src/fake/one.ts again, plus src/fake/one.ts.";
		expect(missingCitedPaths(text, cwd)).toEqual(["src/fake/one.ts"]);
	});

	it("finds nothing in prose without paths", () => {
		expect(missingCitedPaths("All steps done; the gate is green.", cwd)).toEqual([]);
	});
});

describe("wording pins", () => {
	it("citation warning names the count and the paths", () => {
		const warning = citationWarning(["a/b.ts", "c/d.py"]);
		expect(warning).toContain("2 cited path(s)");
		expect(warning).toContain("a/b.ts");
	});

	it("the no-change error names the class", () => {
		expect(NO_CHANGE_ERROR).toContain("no working-tree change");
	});
});
