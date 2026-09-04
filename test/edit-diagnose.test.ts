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

	it("counts a raw duplicate AND its fold-only twin, rather than the smaller raw set", () => {
		// The diagnosis is appended DIRECTLY BELOW pi's own "Found N occurrences"
		// line, so a smaller N is worse than none: it contradicts the message it
		// annotates, and the site it drops is precisely the invisible one the
		// model needs named. Two byte-identical copies plus an NBSP twin — pi
		// folds and sees three; a raw-first count sees two and hides line 5.
		const file = ["a = 1", "b = 2", "a = 1", "b = 2", "a = 1", "b\u00a0= 2", ""].join("\n");
		const result = diagnose(file, "a = 1\nb = 2");
		expect(result.kind).toBe("duplicate");
		if (result.kind !== "duplicate") return;
		expect(result.occurrences).toBe(3);
		expect(result.lines).toEqual([1, 3, 5]);
	});

	// The four cases below are the SAME failure class as the one above, but
	// wearing the disguise that made this module go silent on it. pi counts
	// occurrences in its fuzzy fold (`normalizeForFuzzyMatch`: NFKC, per-line
	// trimEnd, smart quotes, dashes, special spaces) and refuses at 2 — so a
	// second site that is byte-different but fold-identical is a duplicate to pi
	// and, before this fix, exactly ONE raw hit here. `diagnose` returned `ok`,
	// `explain` returned null, and the model got pi's bare "provide more context"
	// with nothing appended. Each of these four fails without the fold-space
	// count: verified by reverting it, all four report kind "ok".
	//
	// Line numbers are asserted, not just the kind, because a `duplicate` with an
	// empty `lines` is the same round trip as no diagnosis at all — `explain`
	// renders no `where` clause for it.
	it("catches the papercut's own shape: parallel blocks split by ONE trailing space", () => {
		// Two identical `except` bodies; the second carries a trailing space on an
		// interior anchor line. Reproduced against pi directly: pi counts 2.
		const file = [
			"try:",
			"    risky()",
			"except ValueError:",
			"    log.warning('bad')",
			"    return None",
			"except KeyError:",
			"    log.warning('bad') ",
			"    return None",
			"",
		].join("\n");
		const result = diagnose(file, "    log.warning('bad')\n    return None");
		expect(result.kind).toBe("duplicate");
		if (result.kind !== "duplicate") return;
		expect(result.occurrences).toBe(2);
		expect(result.lines).toEqual([4, 7]);
		expect(explain(result, "handler.py")).toContain("lines 4, 7");
	});

	it("catches an NBSP twin, which no amount of staring at the file reveals", () => {
		// U+00A0 where the eye sees a space. This one is worth its own case: the
		// model cannot see it, so "provide more context" reads as pi being wrong.
		const file = "a = 1\nb = 2\na = 1\nb = 2\n";
		const result = diagnose(file, "a = 1\nb = 2");
		expect(result.kind).toBe("duplicate");
		if (result.kind !== "duplicate") return;
		expect(result.lines).toEqual([1, 3]);
	});

	it("catches an em-dash twin", () => {
		const file = "total = x - 1\ntotal = x — 1\n";
		const result = diagnose(file, "total = x - 1");
		expect(result.kind).toBe("duplicate");
		if (result.kind !== "duplicate") return;
		expect(result.lines).toEqual([1, 2]);
	});

	it("catches an NFKC twin, where the fold CHANGES LENGTH and the lines still hold", () => {
		// U+FB01 (ﬁ) expands to two characters under NFKC, so every index after it
		// shifts. Line numbers are unaffected because nothing in the fold touches a
		// newline — this case exists to pin that property, not just the count.
		const file = "x = 1\nﬁle = 1\ny = 2\nfile = 1\n";
		const result = diagnose(file, "file = 1");
		expect(result.kind).toBe("duplicate");
		if (result.kind !== "duplicate") return;
		expect(result.occurrences).toBe(2);
		expect(result.lines).toEqual([2, 4]);
	});

	it("does NOT invent a duplicate pi never saw, out of interior whitespace", () => {
		// The counterweight to the four above, and the reason the old
		// `squash`-based fuzzy branch was DELETED rather than kept alongside the
		// new one: `squash` collapses INTERIOR runs of spaces and tabs, which pi
		// does not. This anchor is indented with two tabs and matches nothing in
		// the file, so pi finds it ZERO times and says "could not find". The old
		// branch squashed all three to "return 1;\n}" and answered "it occurs 2
		// times, add context" — sending the model to disambiguate an ambiguity pi
		// never reported, and doing so with `lines: []`, so not even a wrong line
		// number to check the claim against. A near miss is the honest verdict:
		// the indentation IS the difference, and quoting the region shows it.
		const file = ["if (a) {", "\treturn 1;", "}", "", "if (b) {", "    return 1;", "}", ""].join("\n");
		const result = diagnose(file, "\t\treturn 1;\n}");
		expect(result.kind).toBe("near-miss");
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
