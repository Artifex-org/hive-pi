/**
 * The row-script parser, graded on the thing it exists to guarantee: that a
 * payload can only mean one thing.
 *
 * Two properties carry most of the weight and most of the cases below.
 *
 * ESCAPING IS NOT A SPECIAL CASE. Exactly one marker character is stripped and
 * the rest of the line is content, so `++x` is an inserted `+x` for the same
 * reason `+x` is an inserted `x`. If any test here needed a lookahead rule to
 * explain, the format would have a hole.
 *
 * ERRORS ARE OUTPUT, NOT EXCEPTIONS. The consumer of a fault is a model that
 * has to write a corrected script, so every assertion on an error checks the
 * SENTENCE as well as the line number — "unknown operation" alone teaches
 * nothing, "give it a row marker" is the fix.
 */

import { describe, expect, it } from "vitest";

import { type ParseError, type ParsedScript, anchorRows, parseRowScript } from "../extensions/edit-common/rowscript.ts";

function ok(text: string): ParsedScript {
	const result = parseRowScript(text);
	if (!result.ok) throw new Error(`expected a parse, got line ${result.line}: ${result.message}`);
	return result;
}

function bad(text: string): ParseError {
	const result = parseRowScript(text);
	if (result.ok) throw new Error("expected a parse error, got a script");
	return result;
}

describe("operations", () => {
	it("parses a @REPLACE with context, removals and insertions", () => {
		const script = ok(["[src/main.ts]", "@REPLACE", " keep me", "-drop me", "+add me", " keep me too"].join("\n"));
		expect(script.files).toHaveLength(1);
		expect(script.files[0].path).toBe("src/main.ts");
		const op = script.files[0].ops[0];
		expect(op.kind).toBe("replace");
		if (op.kind !== "replace") return;
		expect(op.hunks).toHaveLength(1);
		expect(op.hunks[0].rows).toEqual([
			{ kind: "context", text: "keep me" },
			{ kind: "remove", text: "drop me" },
			{ kind: "add", text: "add me" },
			{ kind: "context", text: "keep me too" },
		]);
	});

	it("splits a @REPLACE into hunks at @@", () => {
		const script = ok(["[a.ts]", "@REPLACE", "-one", "+ONE", "@@", "-two", "+TWO"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "replace") throw new Error("expected replace");
		expect(op.hunks).toHaveLength(2);
		expect(anchorRows(op.hunks[0].rows)).toEqual(["one"]);
		expect(anchorRows(op.hunks[1].rows)).toEqual(["two"]);
	});

	it("parses the line-addressed inserts", () => {
		const script = ok(["[a.ts]", "@INS.PRE 1", "+first", "@INS.POST 12", "+last"].join("\n"));
		const [pre, post] = script.files[0].ops;
		expect(pre).toMatchObject({ kind: "insert-at", where: "pre", target: 1 });
		expect(post).toMatchObject({ kind: "insert-at", where: "post", target: 12 });
		if (pre.kind !== "insert-at") return;
		expect(pre.rows).toEqual([{ kind: "add", text: "first" }]);
	});

	it("parses the anchored inserts and @DEL", () => {
		const script = ok(["[a.ts]", "@INS.BEFORE", "-anchor", "+above", "@INS.AFTER", "-anchor2", "+below", "@DEL", "-gone"].join("\n"));
		expect(script.files[0].ops.map((op) => op.kind)).toEqual(["insert-before", "insert-after", "delete"]);
	});

	it("accepts operation keywords in any case, because a typo is not an ambiguity", () => {
		const script = ok(["[a.ts]", "@replace", "-x", "+y", "@ins.pre 3", "+z"].join("\n"));
		expect(script.files[0].ops.map((op) => op.kind)).toEqual(["replace", "insert-at"]);
	});

	it("records the script line of every operation, so a fault can be pointed at", () => {
		const script = ok(["[a.ts]", "@REPLACE", "-x", "+y", "@DEL", "-z"].join("\n"));
		expect(script.files[0].ops.map((op) => op.line)).toEqual([2, 5]);
	});
});

describe("escaping — one marker off, the rest verbatim", () => {
	it("inserts a line that itself starts with +", () => {
		const script = ok(["[a.ts]", "@INS.PRE 1", "++literal plus"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "insert-at") throw new Error("expected insert-at");
		expect(op.rows[0].text).toBe("+literal plus");
	});

	it("matches a line that itself starts with -", () => {
		const script = ok(["[a.ts]", "@DEL", "---literal minus"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "delete") throw new Error("expected delete");
		expect(op.rows[0]).toEqual({ kind: "remove", text: "--literal minus" });
	});

	it("needs no doubling for @ — the marker position already says what it is", () => {
		const script = ok(["[a.ts]", "@REPLACE", " @@", "-@decorator", "+@property"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "replace") throw new Error("expected replace");
		expect(op.hunks).toHaveLength(1);
		expect(op.hunks[0].rows).toEqual([
			{ kind: "context", text: "@@" },
			{ kind: "remove", text: "@decorator" },
			{ kind: "add", text: "@property" },
		]);
	});

	it("keeps a file line's own leading whitespace", () => {
		const script = ok(["[a.ts]", "@REPLACE", "-\tif (x) {", "+\tif (y) {"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "replace") throw new Error("expected replace");
		expect(op.hunks[0].rows[0].text).toBe("\tif (x) {");
		// A context row for an indented line is a space plus the indentation.
		const indented = ok(["[a.ts]", "@REPLACE", "   deep", "-x", "+y"].join("\n"));
		const other = indented.files[0].ops[0];
		if (other.kind !== "replace") return;
		expect(other.hunks[0].rows[0].text).toBe("  deep");
	});

	it("treats a bare empty line inside an operation as an empty context row", () => {
		// Trailing whitespace does not survive a model or a JSON transport, so a
		// context row for a blank line cannot be required to carry its space.
		const script = ok(["[a.ts]", "@REPLACE", "-before", "", "+after"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "replace") throw new Error("expected replace");
		expect(op.hunks[0].rows).toEqual([
			{ kind: "remove", text: "before" },
			{ kind: "context", text: "" },
			{ kind: "add", text: "after" },
		]);
	});

	it("keeps a `+` row that inserts a blank line, which is two characters not zero", () => {
		const script = ok(["[a.ts]", "@INS.PRE 2", "+", "+next"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "insert-at") throw new Error("expected insert-at");
		expect(op.rows).toEqual([
			{ kind: "add", text: "" },
			{ kind: "add", text: "next" },
		]);
	});
});

describe("normalisation of transport artefacts", () => {
	it("strips CRLF from the script, because line endings come from the file", () => {
		const script = ok("[a.ts]\r\n@REPLACE\r\n-old\r\n+new\r\n");
		const op = script.files[0].ops[0];
		if (op.kind !== "replace") throw new Error("expected replace");
		expect(op.hunks[0].rows).toEqual([
			{ kind: "remove", text: "old" },
			{ kind: "add", text: "new" },
		]);
	});

	it("drops trailing blank lines, which every model emits", () => {
		const script = ok(["[a.ts]", "@INS.PRE 1", "+x", "", "", ""].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "insert-at") throw new Error("expected insert-at");
		expect(op.rows).toHaveLength(1);
	});

	it("accepts a header with a trailing space, and still reads ` [x]` as a context row", () => {
		const script = ok(["[a.ts] ", "@DEL", "-x"].join("\n"));
		expect(script.files[0].path).toBe("a.ts");
		// A LEADING space is the context marker, so trimming both ends would turn
		// an ini-style file line into a header.
		const ini = ok(["[a.ini]", "@REPLACE", " [section]", "-key = 1", "+key = 2"].join("\n"));
		expect(ini.files).toHaveLength(1);
		const op = ini.files[0].ops[0];
		if (op.kind !== "replace") throw new Error("expected replace");
		expect(op.hunks[0].rows[0]).toEqual({ kind: "context", text: "[section]" });
	});

	it("skips blank lines before a header and between a header and its first operation", () => {
		const script = ok(["", "[a.ts]", "", "@DEL", "-x"].join("\n"));
		expect(script.files[0].ops).toHaveLength(1);
	});
});

describe("multiple files", () => {
	it("keeps file sections in order", () => {
		const script = ok(["[a.ts]", "@DEL", "-x", "[b.ts]", "@DEL", "-y"].join("\n"));
		expect(script.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
	});

	it("merges a repeated path, since every operation resolves against the original file", () => {
		const script = ok(["[a.ts]", "@DEL", "-x", "[b.ts]", "@DEL", "-y", "[a.ts]", "@DEL", "-z"].join("\n"));
		expect(script.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
		expect(script.files[0].ops).toHaveLength(2);
	});
});

describe("faults — precise, and never thrown", () => {
	it("reports whitespace-only input as a missing header rather than an empty success", () => {
		const fault = bad("   \n\n");
		expect(fault.line).toBe(0);
		expect(fault.message).toContain("No `[file]` header");
		expect(fault.message).toContain("[path/to/file]");
	});

	it("rejects rows before any file header", () => {
		const fault = bad(["+orphan", "[a.ts]", "@DEL", "-x"].join("\n"));
		expect(fault.line).toBe(1);
		expect(fault.message).toContain("before any `[file]` header");
	});

	it("rejects a row outside any operation", () => {
		const fault = bad(["[a.ts]", "-loose", "@DEL", "-x"].join("\n"));
		expect(fault.line).toBe(2);
		expect(fault.message).toContain("outside any operation");
		expect(fault.message).toContain("@INS.PRE");
	});

	it("rejects an unmarked line and teaches the marker rule", () => {
		const fault = bad(["[a.ts]", "@REPLACE", "-old", "this line forgot its marker"].join("\n"));
		expect(fault.line).toBe(4);
		expect(fault.message).toContain("no row marker");
		expect(fault.message).toContain("`++like this`");
	});

	it("tells an unknown @-operation how to write a literal @ line", () => {
		const fault = bad(["[a.ts]", "@REPLACE", "-old", "@decorator"].join("\n"));
		expect(fault.line).toBe(4);
		expect(fault.message).toContain("Unknown operation");
		expect(fault.message).toContain("`+@decorator`");
	});

	it("rejects @INS.PRE with no line number", () => {
		const fault = bad(["[a.ts]", "@INS.PRE", "+x"].join("\n"));
		expect(fault.line).toBe(2);
		expect(fault.message).toContain("exactly one positive line number");
		expect(fault.message).toContain("none was given");
	});

	it("rejects a non-numeric or zero @INS.PRE target instead of falling through to 'unknown operation'", () => {
		for (const argument of ["x", "0", "5 7", "-3", "1.5"]) {
			const fault = bad(["[a.ts]", `@INS.PRE ${argument}`, "+x"].join("\n"));
			expect(fault.line).toBe(2);
			expect(fault.message).toContain("exactly one positive line number");
			expect(fault.message).toContain(argument);
		}
	});

	it("rejects a hunk with nothing to locate it by, and names the escape hatch", () => {
		const fault = bad(["[a.ts]", "@REPLACE", "+only additions"].join("\n"));
		expect(fault.message).toContain("no `-` rows and no context rows");
		expect(fault.message).toContain("@INS.PRE <line>");
	});

	it("rejects a @REPLACE hunk that is all context, which would succeed at nothing", () => {
		// It locates a region and then changes none of it. Reporting that as a
		// clean apply tells the model an edit landed that never happened, and it
		// also lets a no-op occupy a range the overlap check then trips over.
		const fault = bad(["[a.ts]", "@REPLACE", " one", " two"].join("\n"));
		expect(fault.message).toContain("all context rows");
		expect(fault.message).toContain("changes nothing");
		const second = bad(["[a.ts]", "@REPLACE", "-x", "+y", "@@", " untouched"].join("\n"));
		expect(second.line).toBe(6);
		expect(second.message).toContain("changes nothing");
	});

	it("rejects a dangling @@ at the end of a @REPLACE", () => {
		const fault = bad(["[a.ts]", "@REPLACE", "-x", "+y", "@@"].join("\n"));
		expect(fault.message).toContain("Empty @REPLACE hunk");
	});

	it("rejects an empty hunk between two @@", () => {
		const fault = bad(["[a.ts]", "@REPLACE", "-x", "+y", "@@", "@@", "-z", "+w"].join("\n"));
		expect(fault.line).toBe(6);
		expect(fault.message).toContain("Empty @REPLACE hunk");
	});

	it("rejects @@ outside a @REPLACE", () => {
		const fault = bad(["[a.ts]", "@DEL", "-x", "@@", "-y"].join("\n"));
		expect(fault.line).toBe(4);
		expect(fault.message).toContain("no @REPLACE is open");
	});

	it("rejects an operation with an empty body", () => {
		expect(bad(["[a.ts]", "@DEL"].join("\n")).message).toContain("no rows");
		expect(bad(["[a.ts]", "@DEL", "@INS.PRE 2", "+x"].join("\n")).message).toContain("no rows");
	});

	it("rejects a @DEL that deletes nothing, and a @DEL that adds", () => {
		expect(bad(["[a.ts]", "@DEL", " context only"].join("\n")).message).toContain("deletes nothing");
		expect(bad(["[a.ts]", "@DEL", "-x", "+y"].join("\n")).message).toContain("cannot contain `+` rows");
	});

	it("rejects an anchored insert with no anchor and one with nothing to insert", () => {
		expect(bad(["[a.ts]", "@INS.BEFORE", "+x"].join("\n")).message).toContain("no anchor to insert relative to");
		expect(bad(["[a.ts]", "@INS.AFTER", "-x"].join("\n")).message).toContain("inserts nothing");
	});

	it("rejects text rows in a line-addressed insert and points at @REPLACE", () => {
		const fault = bad(["[a.ts]", "@INS.PRE 4", " context", "+x"].join("\n"));
		expect(fault.message).toContain("addressed by line number");
		expect(fault.message).toContain("@REPLACE");
	});

	it("rejects arguments on the operations that take none, and suggests the one that does", () => {
		expect(bad(["[a.ts]", "@REPLACE 4", "-x", "+y"].join("\n")).message).toContain("takes no argument");
		expect(bad(["[a.ts]", "@INS.BEFORE 4", "-x", "+y"].join("\n")).message).toContain("@INS.PRE");
		expect(bad(["[a.ts]", "@INS.AFTER 4", "-x", "+y"].join("\n")).message).toContain("@INS.POST");
	});

	it("rejects an empty header and a file section with no operations", () => {
		expect(bad(["[]", "@DEL", "-x"].join("\n")).message).toContain("Empty file header");
		expect(bad(["[a.ts]", "[b.ts]", "@DEL", "-x"].join("\n")).message).toContain("[a.ts] has no operations");
		expect(bad(["[a.ts]"].join("\n")).message).toContain("has no operations");
	});

	it("reports the FIRST fault only — a cascade buries the one that is true", () => {
		const fault = bad(["[a.ts]", "@NOPE", "unmarked", "@ALSO-NOPE"].join("\n"));
		expect(fault.line).toBe(2);
	});
});

describe("anchorRows", () => {
	it("is the ordered context and `-` rows, which is what must be present in the file", () => {
		const script = ok(["[a.ts]", "@REPLACE", " a", "-b", "+c", " d"].join("\n"));
		const op = script.files[0].ops[0];
		if (op.kind !== "replace") throw new Error("expected replace");
		expect(anchorRows(op.hunks[0].rows)).toEqual(["a", "b", "d"]);
	});
});
