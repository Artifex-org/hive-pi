import { describe, expect, it } from "vitest";

import { applyEdits, toIndex, workspaceEditToFileEdits } from "../extensions/lens/refactor.ts";

const TEXT = "export function oldName(x: number) {\n\treturn x + 1;\n}\n";

const at = (line: number, character: number) => ({ line, character });
const edit = (sl: number, sc: number, el: number, ec: number, newText: string) => ({
	range: { start: at(sl, sc), end: at(el, ec) },
	newText,
});

describe("toIndex (0-based LSP positions)", () => {
	it("maps line/character to a string index", () => {
		expect(toIndex(TEXT, at(0, 0))).toBe(0);
		expect(TEXT.slice(toIndex(TEXT, at(0, 16)), toIndex(TEXT, at(0, 23)))).toBe("oldName");
	});

	it("handles a later line", () => {
		expect(TEXT.slice(toIndex(TEXT, at(1, 1)), toIndex(TEXT, at(1, 7)))).toBe("return");
	});

	it("counts UTF-16 code units, which is what JS indices are", () => {
		// "😀" is two UTF-16 units; the server's `character` counts it as two.
		const text = 'const s = "😀"; const target = 1;\n';
		expect(text.slice(toIndex(text, at(0, 22)), toIndex(text, at(0, 28)))).toBe("target");
	});

	it("clamps past the last line to the end rather than returning NaN", () => {
		expect(toIndex(TEXT, at(99, 0))).toBe(TEXT.length);
	});

	it("clamps a character past its line to the line end, as the protocol requires", () => {
		expect(toIndex(TEXT, at(0, 9999))).toBe(TEXT.indexOf("\n"));
	});

	it("counts \\r\\n and a lone \\r as line breaks, as the server does", () => {
		const crlf = "a\r\nfoo\r\n";
		expect(crlf.slice(toIndex(crlf, at(1, 0)), toIndex(crlf, at(1, 3)))).toBe("foo");
		const cr = "a\rfoo\r";
		expect(cr.slice(toIndex(cr, at(1, 0)), toIndex(cr, at(1, 3)))).toBe("foo");
	});
});

describe("applyEdits", () => {
	it("applies a single replacement", () => {
		expect(applyEdits(TEXT, [edit(0, 16, 0, 23, "newName")])).toContain("export function newName(");
	});

	it("applies multiple edits on one line without shifting them apart", () => {
		// Two references on one line: naive document-order application corrupts
		// the second once the first changes length.
		const line = "const a = oldName(oldName(1));\n";
		expect(applyEdits(line, [edit(0, 10, 0, 17, "muchLongerName"), edit(0, 18, 0, 25, "muchLongerName")])).toBe(
			"const a = muchLongerName(muchLongerName(1));\n",
		);
	});

	it("applies edits given out of order", () => {
		expect(applyEdits("aa bb\n", [edit(0, 3, 0, 5, "YY"), edit(0, 0, 0, 2, "XX")])).toBe("XX YY\n");
	});

	it("handles an edit spanning lines", () => {
		expect(applyEdits(TEXT, [edit(0, 16, 1, 7, "GONE")])).toBe("export function GONE x + 1;\n}\n");
	});

	it("keeps array order for two inserts at the same point, as the protocol requires", () => {
		expect(applyEdits("ab", [edit(0, 1, 0, 1, "1"), edit(0, 1, 0, 1, "2")])).toBe("a12b");
	});

	it("refuses overlapping ranges rather than picking a winner", () => {
		expect(() => applyEdits("abcdef", [edit(0, 0, 0, 4, "X"), edit(0, 2, 0, 6, "Y")])).toThrow(/overlapping/);
	});
});

describe("workspaceEditToFileEdits", () => {
	it("reads the `changes` shape — what textDocument/rename answers with", () => {
		const result = workspaceEditToFileEdits({
			changes: {
				"file:///repo/src/a.ts": [edit(1, 16, 1, 19, "bar")],
				"file:///repo/src/index.ts": [edit(0, 9, 0, 12, "bar")],
			},
		});
		expect(result).toEqual({
			ok: true,
			files: [
				{ file: "/repo/src/a.ts", edits: [edit(1, 16, 1, 19, "bar")] },
				{ file: "/repo/src/index.ts", edits: [edit(0, 9, 0, 12, "bar")] },
			],
		});
	});

	it("reads the `documentChanges` shape — what workspace/willRenameFiles answers with", () => {
		const result = workspaceEditToFileEdits({
			documentChanges: [
				{ textDocument: { uri: "file:///repo/src/a.ts", version: null }, edits: [edit(0, 24, 0, 33, "../util.js")] },
				{ textDocument: { uri: "file:///repo/src/index.ts", version: null }, edits: [edit(0, 21, 0, 27, "./lib/a.js")] },
			],
		});
		expect(result.ok && result.files.map((f) => f.file)).toEqual(["/repo/src/a.ts", "/repo/src/index.ts"]);
	});

	it("lets documentChanges win over changes, so nothing is applied twice", () => {
		const result = workspaceEditToFileEdits({
			changes: { "file:///repo/a.ts": [edit(0, 0, 0, 1, "x")] },
			documentChanges: [{ textDocument: { uri: "file:///repo/b.ts" }, edits: [edit(0, 0, 0, 1, "y")] }],
		});
		expect(result.ok && result.files.map((f) => f.file)).toEqual(["/repo/b.ts"]);
	});

	it("refuses two edit groups for one file — they apply in sequence, not against one text", () => {
		const result = workspaceEditToFileEdits({
			documentChanges: [
				{ textDocument: { uri: "file:///repo/a.ts" }, edits: [edit(0, 0, 0, 1, "x")] },
				{ textDocument: { uri: "file:///repo/a.ts" }, edits: [edit(1, 0, 1, 1, "y")] },
			],
		});
		expect(!result.ok && result.reason).toMatch(/two edit groups/);
	});

	it("decodes percent-encoded URIs to real paths", () => {
		const result = workspaceEditToFileEdits({ changes: { "file:///repo/my%20dir/a.ts": [edit(0, 0, 0, 1, "x")] } });
		expect(result.ok && result.files[0].file).toBe("/repo/my dir/a.ts");
	});

	it("drops files with no edits rather than rewriting them untouched", () => {
		expect(workspaceEditToFileEdits({ changes: { "file:///repo/a.ts": [] } })).toEqual({ ok: true, files: [] });
	});

	it("refuses a file operation instead of silently skipping it", () => {
		const result = workspaceEditToFileEdits({
			documentChanges: [
				{ textDocument: { uri: "file:///repo/a.ts" }, edits: [edit(0, 0, 0, 1, "x")] },
				{ kind: "rename", oldUri: "file:///repo/a.ts", newUri: "file:///repo/b.ts" },
			],
		});
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toMatch(/`rename` file operation.*Nothing was written/);
	});

	it("refuses a non-file URI", () => {
		const result = workspaceEditToFileEdits({ changes: { "untitled:Untitled-1": [edit(0, 0, 0, 1, "x")] } });
		expect(!result.ok && result.reason).toMatch(/non-file URI/);
	});
});
