import { describe, expect, it } from "vitest";

import {
	applyEdits,
	fileRenameEditsToFileEdits,
	renameSpansToEdits,
	toIndex,
} from "../extensions/lens/refactor.ts";

const TEXT = "export function oldName(x: number) {\n\treturn x + 1;\n}\n";

describe("toIndex", () => {
	it("maps 1-based line/offset to a string index", () => {
		expect(toIndex(TEXT, { line: 1, offset: 1 })).toBe(0);
		expect(toIndex(TEXT, { line: 1, offset: 17 })).toBe(16);
		expect(TEXT.slice(toIndex(TEXT, { line: 1, offset: 17 }), toIndex(TEXT, { line: 1, offset: 24 }))).toBe("oldName");
	});

	it("handles the second line", () => {
		expect(TEXT.slice(toIndex(TEXT, { line: 2, offset: 2 }), toIndex(TEXT, { line: 2, offset: 8 }))).toBe("return");
	});

	it("clamps past the end rather than returning NaN", () => {
		expect(toIndex(TEXT, { line: 99, offset: 1 })).toBe(TEXT.length);
		expect(toIndex(TEXT, { line: 1, offset: 9999 })).toBe(TEXT.length);
	});
});

describe("applyEdits", () => {
	it("applies a single replacement", () => {
		const out = applyEdits(TEXT, [
			{ start: { line: 1, offset: 17 }, end: { line: 1, offset: 24 }, newText: "newName" },
		]);
		expect(out).toContain("export function newName(");
	});

	it("applies multiple edits on one line without shifting them apart", () => {
		// Two references on the same line: naive document-order application
		// corrupts the second once the first changes length.
		const line = "const a = oldName(oldName(1));\n";
		const out = applyEdits(line, [
			{ start: { line: 1, offset: 11 }, end: { line: 1, offset: 18 }, newText: "muchLongerName" },
			{ start: { line: 1, offset: 19 }, end: { line: 1, offset: 26 }, newText: "muchLongerName" },
		]);
		expect(out).toBe("const a = muchLongerName(muchLongerName(1));\n");
	});

	it("applies edits given out of order", () => {
		const line = "aa bb\n";
		const out = applyEdits(line, [
			{ start: { line: 1, offset: 4 }, end: { line: 1, offset: 6 }, newText: "YY" },
			{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 3 }, newText: "XX" },
		]);
		expect(out).toBe("XX YY\n");
	});

	it("handles multi-line edits across lines", () => {
		const out = applyEdits(TEXT, [
			{ start: { line: 1, offset: 17 }, end: { line: 2, offset: 8 }, newText: "GONE" },
		]);
		expect(out).toBe("export function GONE x + 1;\n}\n");
	});
});

describe("renameSpansToEdits", () => {
	it("substitutes the new name — rename spans carry no newText", () => {
		const edits = renameSpansToEdits(
			[{ file: "/a.ts", locs: [{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 4 } }] }],
			"newName",
		);
		expect(edits[0].edits[0].newText).toBe("newName");
	});

	it("keeps prefixText/suffixText, so a shorthand property expands correctly", () => {
		// `{ x }` renamed to `y` must become `{ x: y }`, which tsserver expresses
		// as the span of `x` plus a prefix.
		const edits = renameSpansToEdits(
			[
				{
					file: "/a.ts",
					locs: [{ start: { line: 1, offset: 3 }, end: { line: 1, offset: 4 }, prefixText: "x: " }],
				},
			],
			"y",
		);
		expect(edits[0].edits[0].newText).toBe("x: y");
	});

	it("preserves one group per file", () => {
		const edits = renameSpansToEdits(
			[
				{ file: "/a.ts", locs: [{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 } }] },
				{
					file: "/b.ts",
					locs: [
						{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 } },
						{ start: { line: 2, offset: 1 }, end: { line: 2, offset: 2 } },
					],
				},
			],
			"z",
		);
		expect(edits.map((e) => e.edits.length)).toEqual([1, 2]);
	});
});

describe("fileRenameEditsToFileEdits", () => {
	it("maps getEditsForFileRename's DIFFERENT field names", () => {
		// Regression, measured: `rename` returns {file, locs} while
		// getEditsForFileRename returns {fileName, textChanges}. Reading the second
		// with the first's names yields undefined, filters to empty, and the move
		// then reports "no importers referenced it" and breaks every import.
		const mapped = fileRenameEditsToFileEdits([
			{
				fileName: "/src/index.ts",
				textChanges: [
					{ start: { line: 1, offset: 25 }, end: { line: 1, offset: 35 }, newText: "./sub/thing.ts" },
				],
			},
		]);
		expect(mapped).toEqual([
			{
				file: "/src/index.ts",
				edits: [{ start: { line: 1, offset: 25 }, end: { line: 1, offset: 35 }, newText: "./sub/thing.ts" }],
			},
		]);
	});

	it("drops groups with no changes rather than writing them untouched", () => {
		expect(fileRenameEditsToFileEdits([{ fileName: "/a.ts", textChanges: [] }])).toEqual([]);
	});

	it("survives a malformed group instead of throwing mid-move", () => {
		expect(fileRenameEditsToFileEdits([{ fileName: "/a.ts" } as never])).toEqual([]);
	});
});
