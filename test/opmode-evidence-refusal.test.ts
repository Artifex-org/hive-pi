/**
 * The bugfix_evidence refusal demanded "the id of a completed tool result" —
 * a value the model cannot produce, because Pi's rendered transcript carries
 * no tool-call ids. Agents holding a live reproduction were refused on every
 * attempt and the mandated protocol could not be completed at all (HIV-3078,
 * 6+ blocking papercuts in the week to 2026-08-30).
 *
 * refusalWithCandidates keeps the refusal but hands over the ids it checked
 * against. What must hold: the ids come from the observed-results map (never
 * model-authored), newest first, bounded; and the empty session says "run the
 * reproduction first" rather than listing nothing.
 */

import { describe, expect, it } from "vitest";

import { refusalWithCandidates, type ObservedResult } from "../extensions/opmode/index.ts";

function mapOf(entries: [string, ObservedResult][]): Map<string, ObservedResult> {
	return new Map(entries);
}

describe("refusalWithCandidates", () => {
	it("lists observed ids newest first, so the next call can succeed", () => {
		const out = refusalWithCandidates(
			mapOf([
				["call_a", { name: "bash", failed: true, text: "AssertionError: expected 3" }],
				["call_b", { name: "bash", failed: false, text: "3 passed" }],
			]),
			undefined,
		);
		expect(out).toContain("call_a");
		expect(out).toContain("call_b");
		expect(out.indexOf("call_b")).toBeLessThan(out.indexOf("call_a"));
		expect(out).toContain("(failed)");
		expect(out).toContain("tool_call_id");
	});

	it("names an unknown requested id instead of implying none was given", () => {
		const out = refusalWithCandidates(mapOf([["call_a", { name: "bash", failed: false, text: "ok" }]]), "call_zz");
		expect(out).toContain("call_zz was not observed");
		expect(out).toContain("call_a");
	});

	it("bounds the listing to the newest eight", () => {
		const entries: [string, ObservedResult][] = Array.from({ length: 12 }, (_, i) => [
			`call_${i}`,
			{ name: "bash", failed: false, text: `run ${i}` },
		]);
		const out = refusalWithCandidates(mapOf(entries), undefined);
		expect(out).toContain("call_11");
		expect(out).not.toContain("call_3 "); // call_3 dropped; guard against call_3 matching call_30-style ids
		expect(out).not.toContain("call_0 ");
	});

	it("tells an empty session to reproduce first, not to guess ids", () => {
		const out = refusalWithCandidates(mapOf([]), undefined);
		expect(out).toContain("run the reproduction first");
		expect(out).not.toContain("newest first");
	});

	it("flattens multi-line result text so one row stays one row", () => {
		const out = refusalWithCandidates(
			mapOf([["call_a", { name: "bash", failed: true, text: "line one\nline two\nline three" }]]),
			undefined,
		);
		const row = out.split("\n").find((l) => l.includes("call_a"));
		expect(row).toBeDefined();
		expect(row).toContain("line one line two");
	});
});
