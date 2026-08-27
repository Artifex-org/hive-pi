/**
 * The applier, graded on the three refusals it exists for.
 *
 * 0 matches must be a miss, 2+ must be an ambiguity carrying the line numbers,
 * and one failed operation must reject the whole file. Everything else here is
 * in service of not corrupting a file while doing that: original-coordinate
 * resolution so two inserts do not shift each other, trailing-whitespace
 * tolerance that does NOT extend to interior whitespace, and line endings that
 * come back exactly as they went in.
 *
 * Cases are written end to end — script text through the parser into the
 * applier — because the property being tested is "this payload does that to
 * this file", and hand-building a ParsedScript would test the applier against
 * a structure no model can actually produce.
 */

import { describe, expect, it } from "vitest";

import { type ApplyResult, type Failure, applyScript, describeFailure } from "../extensions/edit-common/apply.ts";
import { parseRowScript } from "../extensions/edit-common/rowscript.ts";

function run(files: Record<string, string>, script: string): ApplyResult {
	const parsed = parseRowScript(script);
	if (!parsed.ok) throw new Error(`script did not parse (line ${parsed.line}): ${parsed.message}`);
	return applyScript(new Map(Object.entries(files)), parsed);
}

/** The new content of the one file the script touched, insisting it succeeded. */
function applied(files: Record<string, string>, script: string): string {
	const result = run(files, script);
	if (!result.ok) {
		const reasons = result.outcomes.flatMap((outcome) =>
			outcome.operations.filter((op) => op.status === "failed").map((op) => JSON.stringify(op.failure)),
		);
		throw new Error(`expected a clean apply, got: ${reasons.join("; ") || JSON.stringify(result.outcomes)}`);
	}
	const [path] = result.files.keys();
	return result.files.get(path) ?? "";
}

/** The failure of the first operation that failed. */
function failure(result: ApplyResult): Failure {
	for (const outcome of result.outcomes) {
		if (outcome.failure) return outcome.failure;
		for (const op of outcome.operations) if (op.status === "failed") return op.failure;
	}
	throw new Error("expected a failure, everything applied");
}

const FILE = ["one", "two", "three", "four", "five", ""].join("\n");

describe("the operations, end to end", () => {
	it("@REPLACE swaps the removed rows for the added ones and keeps the context", () => {
		const out = applied({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", " two", "-three", "+THREE", " four"].join("\n"));
		expect(out).toBe("one\ntwo\nTHREE\nfour\nfive\n");
	});

	it("@REPLACE applies every hunk of a multi-hunk payload", () => {
		const out = applied({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-one", "+ONE", "@@", "-five", "+FIVE"].join("\n"));
		expect(out).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
	});

	it("@INS.PRE and @INS.POST insert on the named side of a line number", () => {
		expect(applied({ "a.txt": FILE }, ["[a.txt]", "@INS.PRE 3", "+zero"].join("\n"))).toBe("one\ntwo\nzero\nthree\nfour\nfive\n");
		expect(applied({ "a.txt": FILE }, ["[a.txt]", "@INS.POST 3", "+zero"].join("\n"))).toBe("one\ntwo\nthree\nzero\nfour\nfive\n");
	});

	it("@INS.BEFORE and @INS.AFTER keep the `-` anchor — there it matches and deletes nothing", () => {
		expect(applied({ "a.txt": FILE }, ["[a.txt]", "@INS.BEFORE", "-three", "+above"].join("\n"))).toBe(
			"one\ntwo\nabove\nthree\nfour\nfive\n",
		);
		expect(applied({ "a.txt": FILE }, ["[a.txt]", "@INS.AFTER", "-two", "-three", "+below"].join("\n"))).toBe(
			"one\ntwo\nthree\nbelow\nfour\nfive\n",
		);
	});

	it("inserts against the `-` rows, not against the context that disambiguates them", () => {
		// A context row exists to make the anchor unique. If it also moved the
		// insertion point, then adding context — the remedy this format tells a
		// model to reach for after an ambiguity — would silently relocate the
		// edit, and it would relocate it while still reporting ok.
		const file = ["import a", "import b", "import z", ""].join("\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@INS.BEFORE", " import a", "-import b", "+import c"].join("\n"))).toBe(
			"import a\nimport c\nimport b\nimport z\n",
		);
		expect(applied({ "a.txt": file }, ["[a.txt]", "@INS.AFTER", "-import a", " import b", "+import c"].join("\n"))).toBe(
			"import a\nimport c\nimport b\nimport z\n",
		);
	});

	it("inserts against the `-` block when context surrounds it on both sides", () => {
		const file = ["one", "two", "three", "four", ""].join("\n");
		const rows = [" one", "-two", "-three", " four"];
		expect(applied({ "a.txt": file }, ["[a.txt]", "@INS.BEFORE", ...rows, "+X"].join("\n"))).toBe("one\nX\ntwo\nthree\nfour\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@INS.AFTER", ...rows, "+X"].join("\n"))).toBe("one\ntwo\nthree\nX\nfour\n");
	});

	it("uses the context only to disambiguate, and lands the insert at the right one of two identical anchors", () => {
		// Without the context row this anchor is ambiguous; with it the insert
		// must land in the SECOND block, immediately above its `-` row.
		const file = ["fn a", "\tbody", "fn b", "\tbody", ""].join("\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@INS.BEFORE", " fn b", "-\tbody", "+\tlog()"].join("\n"))).toBe(
			"fn a\n\tbody\nfn b\n\tlog()\n\tbody\n",
		);
	});

	it("@DEL removes the anchor block", () => {
		expect(applied({ "a.txt": FILE }, ["[a.txt]", "@DEL", "-two", "-three"].join("\n"))).toBe("one\nfour\nfive\n");
	});

	it("@DEL keeps context rows it was told to keep", () => {
		expect(applied({ "a.txt": FILE }, ["[a.txt]", "@DEL", " two", "-three", " four"].join("\n"))).toBe("one\ntwo\nfour\nfive\n");
	});

	it("edits several files in one script", () => {
		const result = run({ "a.txt": "x\n", "b.txt": "y\n" }, ["[a.txt]", "@DEL", "-x", "[b.txt]", "@REPLACE", "-y", "+Y"].join("\n"));
		expect(result.ok).toBe(true);
		expect(result.files.get("a.txt")).toBe("");
		expect(result.files.get("b.txt")).toBe("Y\n");
	});
});

describe("escaping, round-tripped through the applier", () => {
	it("deletes a file line that literally starts with +", () => {
		const file = ["const a = 1;", "+bonus", "const b = 2;", ""].join("\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@DEL", "-+bonus"].join("\n"))).toBe("const a = 1;\nconst b = 2;\n");
	});

	it("inserts a file line that literally starts with +", () => {
		expect(applied({ "a.txt": "x\n" }, ["[a.txt]", "@INS.POST 1", "++bonus"].join("\n"))).toBe("x\n+bonus\n");
	});

	it("matches and replaces a file line that is literally @@", () => {
		const file = ["head", "@@", "tail", ""].join("\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", " head", "-@@", "+@ONE"].join("\n"))).toBe("head\n@ONE\ntail\n");
	});

	it("replaces a decorator line without any doubling", () => {
		const file = ["@decorator", "def f():", ""].join("\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-@decorator", "+@other", " def f():"].join("\n"))).toBe(
			"@other\ndef f():\n",
		);
	});

	it("matches a blank file line written as an empty context row", () => {
		const file = ["head", "", "tail", ""].join("\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", " head", "", "-tail", "+TAIL"].join("\n"))).toBe("head\n\nTAIL\n");
	});
});

describe("anchor resolution — the refusals", () => {
	it("0 matches is a typed ANCHOR_MISS, not a nearest-neighbour guess", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-thre", "+THREE"].join("\n"));
		expect(result.ok).toBe(false);
		expect(result.files.size).toBe(0);
		const fault = failure(result);
		expect(fault.code).toBe("ANCHOR_MISS");
		if (fault.code !== "ANCHOR_MISS") return;
		expect(fault.anchor).toBe("thre");
	});

	it("2+ matches is ANCHOR_AMBIGUOUS carrying 1-based line numbers, not the first hit", () => {
		const file = ["function a() {", "\treturn 1;", "}", "", "function b() {", "\treturn 1;", "}", ""].join("\n");
		const result = run({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-\treturn 1;", "+\treturn 2;"].join("\n"));
		expect(result.ok).toBe(false);
		const fault = failure(result);
		expect(fault.code).toBe("ANCHOR_AMBIGUOUS");
		if (fault.code !== "ANCHOR_AMBIGUOUS") return;
		expect(fault.lines).toEqual([2, 6]);
		expect(fault.more).toBe(0);
		// The remedy is a context row, and it must actually work.
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", " function b() {", "-\treturn 1;", "+\treturn 2;"].join("\n"))).toContain(
			"function b() {\n\treturn 2;",
		);
	});

	it("does not consume duplicate matches in order — two identical hunks both fail", () => {
		// A "take them in sequence" fallback would make this work, and would
		// also silently edit the wrong occurrence when a script is one hunk
		// short. Both hunks report the ambiguity instead.
		const file = ["x", "x", ""].join("\n");
		const result = run({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-x", "+A", "@@", "-x", "+B"].join("\n"));
		expect(result.ok).toBe(false);
		expect(failure(result).code).toBe("ANCHOR_AMBIGUOUS");
	});

	it("caps the reported duplicate sites and counts the rest", () => {
		const file = `${Array.from({ length: 12 }, () => "dup").join("\n")}\n`;
		const result = run({ "a.txt": file }, ["[a.txt]", "@DEL", "-dup"].join("\n"));
		const fault = failure(result);
		if (fault.code !== "ANCHOR_AMBIGUOUS") throw new Error("expected ambiguity");
		expect(fault.lines).toHaveLength(8);
		expect(fault.more).toBe(4);
	});

	it("matches a multi-line anchor only where the whole block is contiguous", () => {
		const file = ["a", "b", "c", "a", "x", "c", ""].join("\n");
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-a", "-b", "+ab"].join("\n"))).toBe("ab\nc\na\nx\nc\n");
	});
});

describe("whitespace tolerance — trailing only", () => {
	it("matches across a trailing-whitespace difference", () => {
		const file = "const a = 1;   \nconst b = 2;\n";
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-const a = 1;", "+const a = 3;"].join("\n"))).toBe(
			"const a = 3;\nconst b = 2;\n",
		);
	});

	it("refuses to match across an INTERIOR whitespace difference", () => {
		const result = run({ "a.txt": "if (x) {\n}\n" }, ["[a.txt]", "@REPLACE", "-if(x) {", "+if (y) {"].join("\n"));
		expect(failure(result).code).toBe("ANCHOR_MISS");
	});

	it("keeps a context line's own trailing whitespace — it was told to leave it alone", () => {
		const file = "keep me   \ndrop me\n";
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", " keep me", "-drop me", "+kept"].join("\n"))).toBe("keep me   \nkept\n");
	});

	it("an exact single match wins even where the tolerant pass would find several", () => {
		// Exact hits line 2 once; rtrim-tolerantly the anchor hits both lines.
		const file = "value   \nvalue\nvalue   \n";
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-value", "+VALUE"].join("\n"))).toBe("value   \nVALUE\nvalue   \n");
	});
});

describe("original-coordinate resolution", () => {
	it("two @INS.PRE in one payload do not shift each other's targets", () => {
		const out = applied({ "a.txt": FILE }, ["[a.txt]", "@INS.PRE 2", "+A", "@INS.PRE 4", "+B"].join("\n"));
		// Both line numbers refer to the file as it arrived: A before "two", B
		// before "four". A naive applier walks B down to before "five".
		expect(out).toBe("one\nA\ntwo\nthree\nB\nfour\nfive\n");
	});

	it("holds when the later target is written first", () => {
		const out = applied({ "a.txt": FILE }, ["[a.txt]", "@INS.PRE 4", "+B", "@INS.PRE 2", "+A"].join("\n"));
		expect(out).toBe("one\nA\ntwo\nthree\nB\nfour\nfive\n");
	});

	it("survives a deletion above a line-addressed insert", () => {
		const out = applied({ "a.txt": FILE }, ["[a.txt]", "@DEL", "-one", "@INS.PRE 4", "+B"].join("\n"));
		expect(out).toBe("two\nthree\nB\nfour\nfive\n");
	});

	it("a multi-line insert at one point does not move a later anchor", () => {
		const out = applied(
			{ "a.txt": FILE },
			["[a.txt]", "@INS.PRE 1", "+x", "+y", "+z", "@REPLACE", "-five", "+FIVE"].join("\n"),
		);
		expect(out).toBe("x\ny\nz\none\ntwo\nthree\nfour\nFIVE\n");
	});

	it("puts a zero-width insert above a replacement that starts at the same line, in either script order", () => {
		const forward = applied({ "a.txt": FILE }, ["[a.txt]", "@INS.PRE 3", "+above", "@REPLACE", "-three", "+THREE"].join("\n"));
		const reversed = applied({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-three", "+THREE", "@INS.PRE 3", "+above"].join("\n"));
		expect(forward).toBe("one\ntwo\nabove\nTHREE\nfour\nfive\n");
		expect(reversed).toBe(forward);
	});

	it("keeps script order between two inserts at the same point", () => {
		expect(applied({ "a.txt": FILE }, ["[a.txt]", "@INS.PRE 2", "+first", "@INS.PRE 2", "+second"].join("\n"))).toBe(
			"one\nfirst\nsecond\ntwo\nthree\nfour\nfive\n",
		);
	});
});

describe("all-or-nothing, per file", () => {
	it("rejects the whole file when one of its operations fails", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-one", "+ONE", "@DEL", "-nowhere"].join("\n"));
		expect(result.ok).toBe(false);
		expect(result.files.has("a.txt")).toBe(false);
		expect(result.outcomes[0].operations.map((op) => op.status)).toEqual(["ok", "failed"]);
	});

	it("reports every failing operation in one reply, not one per round trip", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@DEL", "-nowhere", "@DEL", "-elsewhere", "@INS.POST 99", "+x"].join("\n"));
		expect(result.outcomes[0].operations.map((op) => op.status)).toEqual(["failed", "failed", "failed"]);
	});

	it("names the failing operation by its script line", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-one", "+ONE", "@DEL", "-nowhere"].join("\n"));
		const failed = result.outcomes[0].operations[1];
		expect(failed.op).toMatchObject({ index: 1, kind: "delete", scriptLine: 5 });
	});

	it("still applies a healthy file when a sibling file fails, and says so in ok", () => {
		const result = run({ "a.txt": "x\n", "b.txt": "y\n" }, ["[a.txt]", "@DEL", "-x", "[b.txt]", "@DEL", "-nowhere"].join("\n"));
		expect(result.ok).toBe(false);
		expect(result.files.get("a.txt")).toBe("");
		expect(result.files.has("b.txt")).toBe(false);
	});

	it("reports a file the caller did not supply, without touching the others", () => {
		const result = run({ "a.txt": "x\n" }, ["[a.txt]", "@DEL", "-x", "[gone.txt]", "@DEL", "-y"].join("\n"));
		expect(result.outcomes[1]).toMatchObject({ path: "gone.txt", ok: false, failure: { code: "FILE_MISSING" } });
		expect(result.outcomes[1].operations).toEqual([]);
	});
});

describe("overlap", () => {
	it("refuses two operations that edit the same lines", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-two", "-three", "+X", "@DEL", "-three"].join("\n"));
		expect(result.ok).toBe(false);
		const fault = failure(result);
		expect(fault.code).toBe("OVERLAP");
		if (fault.code !== "OVERLAP") return;
		expect(fault.withOperation).toBe(0);
		expect(fault.lines).toEqual([3, 3]);
	});

	it("blames only the later of a colliding pair", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-two", "-three", "+X", "@DEL", "-three"].join("\n"));
		expect(result.outcomes[0].operations.map((op) => op.status)).toEqual(["ok", "failed"]);
	});

	it("refuses an insert placed inside a region another operation replaces", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-two", "-three", "-four", "+X", "@INS.PRE 3", "+mid"].join("\n"));
		const fault = failure(result);
		expect(fault.code).toBe("OVERLAP");
		if (fault.code !== "OVERLAP") return;
		// A zero-width insert covers no lines; its range must not come back
		// inverted and be rendered as "lines 3-2".
		expect(fault.lines).toEqual([3, 3]);
		expect(describeFailure("a.txt", fault)).toContain("the same line 3");
	});

	it("tells a @REPLACE whose own two hunks collide to merge the HUNKS, not the operations", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-two", "-three", "+X", "@@", "-three", "-four", "+Y"].join("\n"));
		const fault = failure(result);
		expect(fault.code).toBe("OVERLAP");
		if (fault.code !== "OVERLAP") return;
		expect(fault.operation).toBe(fault.withOperation);
		const message = describeFailure("a.txt", fault);
		expect(message).toContain("Two hunks of the same operation");
		expect(message).toContain("combine them into one hunk");
	});

	it("allows an insert at the edge of a replaced region — half-open ranges do not touch", () => {
		const out = applied({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-two", "-three", "+X", "@INS.POST 3", "+after"].join("\n"));
		expect(out).toBe("one\nX\nafter\nfour\nfive\n");
	});
});

describe("line endings and file edges", () => {
	it("preserves CRLF", () => {
		const file = "one\r\ntwo\r\nthree\r\n";
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-two", "+TWO"].join("\n"))).toBe("one\r\nTWO\r\nthree\r\n");
	});

	it("gives inserted lines the file's own line ending", () => {
		const file = "one\r\ntwo\r\n";
		expect(applied({ "a.txt": file }, ["[a.txt]", "@INS.POST 1", "+mid"].join("\n"))).toBe("one\r\nmid\r\ntwo\r\n");
	});

	it("keeps a file that ends without a newline ending without one", () => {
		expect(applied({ "a.txt": "one\ntwo" }, ["[a.txt]", "@REPLACE", "-one", "+ONE"].join("\n"))).toBe("ONE\ntwo");
	});

	it("gives a new last line the terminator the old one lacked", () => {
		expect(applied({ "a.txt": "one\ntwo" }, ["[a.txt]", "@INS.POST 2", "+three"].join("\n"))).toBe("one\ntwo\nthree");
	});

	it("does not rewrite the endings of lines it did not touch in a mixed-ending file", () => {
		const file = "one\r\ntwo\nthree\r\n";
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-three", "+THREE"].join("\n"))).toBe("one\r\ntwo\nTHREE\r\n");
	});

	it("leaves an odd LAST line's ending alone when the edit is elsewhere", () => {
		// The dominant ending here is LF and the last line is CRLF, so anything
		// that reaches for the dominant ending on the final line restyles a line
		// this edit never mentions.
		const file = "one\ntwo\r\n";
		expect(applied({ "a.txt": file }, ["[a.txt]", "@REPLACE", "-one", "+ONE"].join("\n"))).toBe("ONE\ntwo\r\n");
	});

	it("appends with @INS.PRE one past the end", () => {
		expect(applied({ "a.txt": "one\ntwo\n" }, ["[a.txt]", "@INS.PRE 3", "+three"].join("\n"))).toBe("one\ntwo\nthree\n");
	});

	it("rejects a line number past the end, and says what the valid range is", () => {
		const result = run({ "a.txt": "one\ntwo\n" }, ["[a.txt]", "@INS.PRE 4", "+x"].join("\n"));
		const fault = failure(result);
		expect(fault).toEqual({ code: "LINE_OUT_OF_RANGE", target: 4, lineCount: 2 });
		expect(describeFailure("a.txt", fault)).toContain("@INS.PRE accepts 1..3");
		expect(run({ "a.txt": "one\ntwo\n" }, ["[a.txt]", "@INS.POST 3", "+x"].join("\n")).ok).toBe(false);
	});

	it("writes into an empty file with @INS.PRE 1, and refuses @INS.POST 1", () => {
		// A file with no lines has no line to be after. It does have a position
		// before the first one, which is where a first line goes.
		expect(applied({ "a.txt": "" }, ["[a.txt]", "@INS.PRE 1", "+hello"].join("\n"))).toBe("hello\n");
		expect(failure(run({ "a.txt": "" }, ["[a.txt]", "@INS.POST 1", "+hello"].join("\n")))).toEqual({
			code: "LINE_OUT_OF_RANGE",
			target: 1,
			lineCount: 0,
		});
	});

	it("misses rather than crashes when an anchor is longer than the file", () => {
		expect(failure(run({ "a.txt": "one\n" }, ["[a.txt]", "@DEL", "-one", "-two"].join("\n"))).code).toBe("ANCHOR_MISS");
	});

	it("empties a file when every line is deleted", () => {
		expect(applied({ "a.txt": "one\ntwo\n" }, ["[a.txt]", "@DEL", "-one", "-two"].join("\n"))).toBe("");
	});
});

describe("describeFailure — the sentence the model reads", () => {
	it("hands a miss to the HIV-1562 diagnosis, which quotes the near line back", () => {
		const file = "# Linear Issue Manager\n\nUse this skill to file tickets.\n";
		const result = run({ "a.md": file }, ["[a.md]", "@REPLACE", "-# Linear Issue Management", "+# Tickets"].join("\n"));
		const message = describeFailure("a.md", failure(result), file);
		expect(message).toContain("# Linear Issue Manager");
		expect(message).toContain("Do not re-send the anchor you just used.");
	});

	it("falls back to the format's own advice when it has no file to scan", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@DEL", "-nowhere at all"].join("\n"));
		const message = describeFailure("a.txt", failure(result));
		expect(message).toContain("WHOLE lines");
		expect(message).toContain("@INS.PRE");
	});

	it("names the duplicate lines instead of asking for more context in the abstract", () => {
		const file = "dup\nother\ndup\n";
		const result = run({ "a.txt": file }, ["[a.txt]", "@DEL", "-dup"].join("\n"));
		const message = describeFailure("a.txt", failure(result), file);
		expect(message).toContain("occurs 2 times");
		expect(message).toContain("lines 1, 3");
		expect(message).toContain("Do not resend the same anchor");
	});

	it("explains an overlap as one operation to merge, not two to retry", () => {
		const result = run({ "a.txt": FILE }, ["[a.txt]", "@REPLACE", "-two", "-three", "+X", "@DEL", "-three"].join("\n"));
		const message = describeFailure("a.txt", failure(result));
		expect(message).toContain("operation 1");
		expect(message).toContain("neither was applied");
	});

	it("points a missing file at its header", () => {
		const result = run({}, ["[gone.txt]", "@DEL", "-x"].join("\n"));
		expect(describeFailure("gone.txt", failure(result))).toContain("[gone.txt]");
	});
});
