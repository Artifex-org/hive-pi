/**
 * A run's text: per node, never a second copy of a barrier's members, and every
 * cut a stated page (papercuts 2026-10-02T14:14 "ended mid-string in reviews#2
 * ('disappe')", 2026-10-02T22:5x "repeated full child outputs again under
 * barrier 'join' and cut off before final 'reconcile'").
 */

import { describe, expect, it } from "vitest";

import { runPlan, type Spawn } from "../extensions/agenda/executor.ts";
import type { Plan } from "../extensions/agenda/plan-schema.ts";
import { nodeResultText, pageText, renderRunResults, selectableNodes } from "../extensions/agenda/run-output.ts";

const PLAN: Plan = {
	name: "p",
	description: "d",
	nodes: [
		{ id: "a", kind: "agent", role: "research", prompt: "do a" },
		{ id: "b", kind: "agent", role: "research", prompt: "do b" },
		{ id: "join", kind: "barrier", needs: ["a", "b"] },
		{ id: "reviews", kind: "fanout", over: "join", role: "research", prompt: "review {item}" },
		{ id: "reconcile", kind: "agent", role: "research", prompt: "do reconcile", needs: ["reviews"] },
	],
};

async function run() {
	const spawn: Spawn = async (dispatch) => ({
		ok: true,
		value: dispatch.nodeId === "reviews" ? `REVIEW OF ${String(dispatch.item)}\nline two` : `${dispatch.nodeId.toUpperCase()}-OUT`,
		tokens: 1,
	});
	return runPlan({ plan: PLAN, spawn });
}

describe("renderRunResults", () => {
	it("renders each node and each fanout element as text under its own heading, in plan order", async () => {
		const text = renderRunResults(PLAN, await run());
		expect(text).toContain("### a\nA-OUT");
		expect(text).toContain("### reviews#1\nREVIEW OF B-OUT\nline two");
		expect(text.indexOf("### reviews#1")).toBeLessThan(text.indexOf("### reconcile"));
		expect(text).toContain("### reconcile\nRECONCILE-OUT");
	});

	it("does not repeat a barrier's members under the barrier", async () => {
		const text = renderRunResults(PLAN, await run());
		expect(text.match(/A-OUT/g)?.length).toBe(1 + 1); // node a, and inside reviews#0's own text
		expect(nodeResultText(PLAN, await run(), "join")).toBe("(barrier — joins a, b; each result is under its own node)");
	});

	it("selects slots and refuses ids the run does not have", async () => {
		const summary = await run();
		expect(selectableNodes(PLAN, summary)).toEqual(["a", "b", "join", "reviews", "reviews#0", "reviews#1", "reconcile"]);
		expect(nodeResultText(PLAN, summary, "reviews#0")).toBe("REVIEW OF A-OUT\nline two");
		expect(nodeResultText(PLAN, summary, "reviews#2")).toBeUndefined();
		expect(nodeResultText(PLAN, summary, "nope")).toBeUndefined();
	});
});

describe("pageText", () => {
	const more = (next: number) => `call(offset:${next})`;

	it("says a short text is complete", () => {
		expect(pageText("hello", 0, 100, more)).toEqual({ page: "hello", footer: "[all 5 characters — complete]" });
	});

	it("states the range, the remainder and the call for the next page", () => {
		const first = pageText("abcdefghij", 0, 4, more);
		expect(first).toEqual({
			page: "abcd",
			nextOffset: 4,
			footer: "[showing characters 0–4 of 10; 6 more — call(offset:4) for the next page]",
		});
		const last = pageText("abcdefghij", 8, 4, more);
		expect(last).toEqual({ page: "ij", footer: "[characters 8–10 of 10 — complete]" });
	});

	it("pages reassemble the whole text exactly", () => {
		const text = "x".repeat(1234) + "TAIL";
		let offset: number | undefined = 0;
		let joined = "";
		while (offset !== undefined) {
			const page = pageText(text, offset, 100, more);
			joined += page.page;
			offset = page.nextOffset;
		}
		expect(joined).toBe(text);
	});
});
