/**
 * The anchor diagnosis, graded on the failures it was built from.
 *
 * Every case in the first describe block is a REAL failure taken from the
 * HIV-1562 forensics pass over 182 session transcripts — the failed anchor on
 * the left, the anchor that eventually worked on the right. That is the bar:
 * not "does the function return a string", but "would this have told the model
 * what it spent a round trip discovering".
 */

import { describe, expect, it } from "vitest";

import { diagnose, explain, similarity } from "../extensions/edit-common/diagnose.ts";
import { DIAGNOSIS_MARKER, diagnoseFailedEdit } from "../extensions/pretty-tools.ts";

describe("diagnose — the measured failure classes", () => {
	it("names the line for the single most common class: a near miss", () => {
		// 31% of paired failures. Model wrote '# Linear Issue Management';
		// the file said '# Linear Issue Manager'.
		const file = "# Linear Issue Manager\n\nUse this skill to file tickets.\n";
		const result = diagnose(file, "# Linear Issue Management\n");
		expect(result.kind).toBe("near-miss");
		if (result.kind !== "near-miss") return;
		expect(result.candidates[0].line).toBe(1);
		expect(result.candidates[0].text).toContain("# Linear Issue Manager");

		const message = explain(result, "SKILL.md");
		expect(message).toContain("lines 1-2");
		expect(message).toContain("# Linear Issue Manager");
		// The bytes are fenced, so a trailing blank line the model must reproduce
		// is visible rather than swallowed by the surrounding prose.
		expect(message).toContain("--- begin ---\n# Linear Issue Manager\n\n--- end ---");
		// The instruction matters as much as the evidence: the measured behaviour
		// is a confident model re-sending the same anchor.
		expect(message).toContain("Do not re-send the anchor you just used.");
	});

	it("handles the glob near miss, where one character is the whole difference", () => {
		const file = '{\n  "compilerOptions": {},\n  "include": ["*.ts"]\n}\n';
		const result = diagnose(file, '  "include": ["**/*.ts"]\n}');
		expect(result.kind).toBe("near-miss");
		if (result.kind !== "near-miss") return;
		expect(result.candidates[0].text).toContain('"include": ["*.ts"]');
	});

	it("lists the duplicate sites by line, instead of asking for 'more context'", () => {
		// 22% of paired failures were ambiguous anchors whose recovery just added
		// a neighbouring line. Naming the lines is what makes that a one-shot fix.
		const file = ["function a() {", "\treturn 1;", "}", "", "function b() {", "\treturn 1;", "}", ""].join("\n");
		const result = diagnose(file, "\treturn 1;");
		expect(result.kind).toBe("duplicate");
		if (result.kind !== "duplicate") return;
		expect(result.occurrences).toBe(2);
		expect(result.lines).toEqual([2, 6]);
		expect(explain(result, "x.ts")).toContain("lines 2, 6");
	});

	it("says 'not there' rather than offering an unrelated region", () => {
		// The 9% class: the anchor bore little relation to the file. A confident
		// "closest match" here sends the model to edit the wrong place, which is
		// worse than the original failure.
		const file = '{\n  "name": "hive-pi",\n  "version": "1.0.0"\n}\n';
		const result = diagnose(file, 'pi.on("session_start", (_event, ctx) => installFooter(ctx));\n');
		expect(result.kind).toBe("absent");
		expect(explain(result, "package.json")).toContain("Read the file");
	});

	it("stays silent when the anchor is fine — the failure was something else", () => {
		// Overlapping edits, a guard block, an unreadable file. Adding a paragraph
		// there trains the reader to skip the paragraph.
		const file = "alpha\nbeta\ngamma\n";
		expect(diagnose(file, "beta").kind).toBe("ok");
		expect(explain({ kind: "ok" }, "x.ts")).toBeNull();
	});
});

describe("diagnose — properties that keep it safe", () => {
	it("bounds how much of the file it quotes back", () => {
		const anchor = Array.from({ length: 60 }, (_, i) => `line ${i} of the anchor`).join("\n");
		const file = Array.from({ length: 60 }, (_, i) => `line ${i} of the anchorx`).join("\n");
		const result = diagnose(file, anchor);
		expect(result.kind).toBe("near-miss");
		if (result.kind !== "near-miss") return;
		expect(result.candidates[0].text.split("\n").length).toBeLessThanOrEqual(12);
		expect(result.candidates[0].truncated).toBe(true);
	});

	it("reports two candidate PLACES, not two offsets into one place", () => {
		// Windows overlap, so a single good region scores well at several starts.
		// Without run-collapsing, both "candidates" would be the same block ±1
		// line, which reads as two options and is one.
		const block = "function handler() {\n\treturn compute(a, b);\n}";
		const file = `${block.replace("a, b", "a, c")}\n\nconst x = 1;\n\n${block.replace("compute", "computeAll")}\n`;
		const result = diagnose(file, block);
		expect(result.kind).toBe("near-miss");
		if (result.kind !== "near-miss") return;
		const lines = result.candidates.map((c) => c.line);
		expect(new Set(lines).size).toBe(lines.length);
		expect(Math.abs(lines[0] - (lines[1] ?? lines[0] + 99))).toBeGreaterThan(2);
	});

	it("treats CRLF like pi does, rather than reporting a phantom mismatch", () => {
		const file = "alpha\r\nbeta\r\ngamma\r\n";
		expect(diagnose(file, "beta\n").kind).toBe("ok");
	});

	it("does not call a whitespace-only difference absent", () => {
		// pi already fuzzy-matches whitespace, so this anchor would never reach
		// the diagnosis in production — but if the floor were tuned wrong it
		// would answer "not there" for text that is plainly there.
		const file = "if (a) {\n    return 1;\n}\n";
		expect(diagnose(file, "if (a) {\n\treturn 1;\n}").kind).not.toBe("absent");
	});

	it("similarity is bounded, symmetric and 1 only for the same text", () => {
		expect(similarity("abc", "abc")).toBe(1);
		expect(similarity("", "abc")).toBe(0);
		expect(similarity("hello world", "hello there")).toBeGreaterThan(0.4);
		expect(similarity("hello world", "hello there")).toBeLessThan(1);
		expect(similarity("abcdef", "fedcba")).toBe(similarity("fedcba", "abcdef"));
	});
});

describe("diagnoseFailedEdit — the wiring", () => {
	const file = "# Linear Issue Manager\n\nbody\n";
	const read = () => file;

	it("marks its output so the A/B can tell an informed retry from a blind one", () => {
		const message = diagnoseFailedEdit({ path: "/repo/SKILL.md", edits: [{ oldText: "# Linear Issue Management\n" }] }, "/repo", read);
		expect(message).toContain(DIAGNOSIS_MARKER);
		expect(message).toContain("# Linear Issue Manager");
	});

	it("resolves a relative path against the session cwd, as pi's applier does", () => {
		const seen: string[] = [];
		diagnoseFailedEdit({ path: "SKILL.md", edits: [{ oldText: "nope" }] }, "/repo", (path) => {
			seen.push(path);
			return file;
		});
		expect(seen).toEqual(["/repo/SKILL.md"]);
	});

	it("diagnoses the FIRST broken anchor, not every anchor in the call", () => {
		// pi fails the whole call on the first bad edit, so the later ones were
		// never evaluated — diagnosing them would invent problems.
		const message = diagnoseFailedEdit(
			{ path: "/repo/SKILL.md", edits: [{ oldText: "body" }, { oldText: "# Linear Issue Management\n" }] },
			"/repo",
			read,
		);
		expect(message).toContain("# Linear Issue Manager");
	});

	it("returns null rather than throwing when the file cannot be read", () => {
		// A diagnostic that can break the tool it explains is a bad trade: the
		// caller re-throws pi's original error untouched.
		const message = diagnoseFailedEdit({ path: "/repo/gone.md", edits: [{ oldText: "x" }] }, "/repo", () => {
			throw new Error("ENOENT");
		});
		expect(message).toBeNull();
	});

	it("returns null on input shapes it does not understand", () => {
		expect(diagnoseFailedEdit(null, "/repo", read)).toBeNull();
		expect(diagnoseFailedEdit({ edits: [{ oldText: "x" }] }, "/repo", read)).toBeNull();
		expect(diagnoseFailedEdit({ path: "/repo/SKILL.md" }, "/repo", read)).toBeNull();
		expect(diagnoseFailedEdit({ path: "/repo/SKILL.md", edits: [] }, "/repo", read)).toBeNull();
	});

	it("says nothing when the anchor is present exactly once", () => {
		expect(diagnoseFailedEdit({ path: "/repo/SKILL.md", edits: [{ oldText: "body" }] }, "/repo", read)).toBeNull();
	});
});
