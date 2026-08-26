/**
 * Verdict parsing.
 *
 * The property under test throughout: **an unparseable answer is an ERROR, not
 * `ok:false`.** Those two look identical to a sloppy parser and are opposite in
 * consequence — reading "the judge failed" as "the condition is not met" spends
 * an iteration, injects a continuation, and hands the model a fabricated reason
 * to act on. Repeated a few times it burns the entire budget on a goal that may
 * have been achieved on turn one.
 */

import { describe, expect, it } from "vitest";
import { parseVerdict } from "../extensions/agenda/verdict.ts";

function verdict(raw: string) {
	const result = parseVerdict(raw);
	if (result.kind !== "verdict") throw new Error(`expected a verdict, got error: ${result.message}`);
	return result.verdict;
}

function errorMessage(raw: string): string {
	const result = parseVerdict(raw);
	if (result.kind !== "error") throw new Error(`expected an error, got verdict ${JSON.stringify(result.verdict)}`);
	return result.message;
}

describe("parseVerdict — accepts", () => {
	it("a bare JSON object", () => {
		expect(verdict('{"ok": true, "reason": "tests pass"}')).toEqual({ ok: true, reason: "tests pass" });
	});

	it("a fenced block", () => {
		expect(verdict('```json\n{"ok": false, "reason": "3 tests still fail"}\n```')).toEqual({
			ok: false,
			reason: "3 tests still fail",
		});
	});

	it("a fence without a language tag", () => {
		expect(verdict('```\n{"ok": true, "reason": "done"}\n```')).toEqual({ ok: true, reason: "done" });
	});

	it("surrounding whitespace", () => {
		expect(verdict('\n\n  {"ok": true, "reason": "done"}  \n')).toEqual({ ok: true, reason: "done" });
	});

	it("and trims the reason", () => {
		expect(verdict('{"ok": false, "reason": "  still building  "}').reason).toBe("still building");
	});
});

describe("parseVerdict — errors, never ok:false", () => {
	it("on prose", () => {
		expect(errorMessage("The goal looks complete to me.")).toContain("did not return a JSON object");
	});

	it("on an empty answer — a crashed or silent judge", () => {
		expect(errorMessage("")).toContain("did not return a JSON object");
	});

	it("on a STRING ok, which is a schema failure not a false", () => {
		// Coercing "true" would let a judge that cannot follow the schema decide
		// whether the goal is finished.
		expect(errorMessage('{"ok": "true", "reason": "done"}')).toContain('"ok" must be a boolean');
	});

	it("on a numeric ok", () => {
		expect(errorMessage('{"ok": 1, "reason": "done"}')).toContain('"ok" must be a boolean');
	});

	it("on a missing ok", () => {
		expect(errorMessage('{"reason": "done"}')).toContain('"ok" must be a boolean');
	});

	it("on a missing reason", () => {
		expect(errorMessage('{"ok": false}')).toContain("reason");
	});

	it("on an empty reason", () => {
		// ok:true with no stated reason is indistinguishable from a rubber stamp.
		expect(errorMessage('{"ok": true, "reason": "   "}')).toContain("reason");
	});

	it("on malformed JSON", () => {
		expect(errorMessage('{"ok": true, "reason": }')).toContain("invalid JSON");
	});

	it("on a JSON array", () => {
		expect(errorMessage('[{"ok": true, "reason": "done"}]')).toContain("did not return a JSON object");
	});

	it("on prose wrapped around a valid object", () => {
		// Refused rather than guessed at: picking a candidate out of commentary
		// is exactly the silent-wrong-answer class this module prevents.
		expect(errorMessage('Here you go: {"ok": true, "reason": "done"} — hope that helps!')).toContain(
			"did not return a JSON object",
		);
	});

	it("on an absurdly large answer, without trying to parse it", () => {
		expect(errorMessage("x".repeat(70_000))).toContain("too large");
	});
});

describe("parseVerdict — the error message is diagnosable", () => {
	it("quotes a preview of what came back instead", () => {
		expect(errorMessage("I think it is probably fine now")).toContain("I think it is probably fine now");
	});

	it("collapses whitespace in that preview so it stays one line", () => {
		expect(errorMessage("line one\n\n\nline two")).not.toContain("\n");
	});
});
