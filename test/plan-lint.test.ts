import { describe, expect, it } from "vitest";
import { lintPlanComposition } from "../extensions/plan/lint.ts";
import { applyOps, emptyPlan } from "../extensions/plan/state.ts";

const now = 1_700_000_000_000;

describe("lintPlanComposition", () => {
	it("advises typed representations without rejecting prose", () => {
		const doc = applyOps(emptyPlan(now), [{ op: "upsert", block: { type: "text", markdown: "The flow has 3 stages; compare options and verify HIV-2907." } }], now).doc;
		expect(lintPlanComposition(doc).map((issue) => issue.kind)).toEqual(["diagram", "table", "metrics", "checklist", "ticket"]);
	});

	it("stays quiet once matching typed blocks are present", () => {
		const doc = applyOps(emptyPlan(now), [
			{ op: "upsert", block: { type: "text", markdown: "The flow has 3 stages; compare options and verify HIV-2907." } },
			{ op: "upsert", block: { type: "diagram", mermaid: "flowchart TD" } },
			{ op: "upsert", block: { type: "table", columns: ["a"], rows: [["b"]] } },
			{ op: "upsert", block: { type: "metrics", metrics: [{ label: "stages", value: "3" }] } },
			{ op: "upsert", block: { type: "checklist", items: [{ id: "gate", text: "verify" }] } },
			{ op: "upsert", block: { type: "ticket", key: "HIV-2907" } },
		], now).doc;
		expect(lintPlanComposition(doc)).toEqual([]);
	});
});
