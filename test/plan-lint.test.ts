import { describe, expect, it } from "vitest";
import { lintPlanComposition } from "../extensions/plan/lint.ts";
import { applyOps, emptyPlan } from "../extensions/plan/state.ts";

const now = 1_700_000_000_000;
const lint = (markdown: string) => lintPlanComposition(applyOps(emptyPlan(now), [{ op: "upsert", block: { type: "text", markdown } }], now).doc).map((issue) => issue.kind);

describe("lintPlanComposition", () => {
	it("advises the five supported representations", () => {
		expect(lint("The flow has 3 stages; compare options and verify HIV-2907.")).toEqual(["diagram", "table", "metrics", "checklist", "ticket"]);
	});
	it("recognises asserted quantities, not versions, dates, or step references", () => {
		expect(lint("About 40 callers and 12% of sessions need review.")).toContain("metrics");
		for (const text of ["Bump Node to 24 and re-run the suite.", "The regression landed on 2026-08-27.", "Do step 2 before step 3."]) expect(lint(text)).not.toContain("metrics");
	});
	it("does not mistake encodings and protocols for ticket keys", () => {
		expect(lint("Fix the UTF-8 handling and migrate to HTTP-2.")).not.toContain("ticket");
		expect(lint("Track HIV-2907.")).toContain("ticket");
	});
	it("stays quiet once matching typed blocks are present", () => {
		const doc = applyOps(emptyPlan(now), [
			{ op: "upsert", block: { type: "text", markdown: "The flow has 3 stages; compare options and verify HIV-2907." } },
			{ op: "upsert", block: { type: "diagram", mermaid: "flowchart TD" } }, { op: "upsert", block: { type: "table", columns: ["a"], rows: [["b"]] } },
			{ op: "upsert", block: { type: "metrics", metrics: [{ label: "stages", value: "3" }] } }, { op: "upsert", block: { type: "checklist", items: [{ id: "gate", text: "verify" }] } }, { op: "upsert", block: { type: "ticket", key: "HIV-2907" } },
		], now).doc;
		expect(lintPlanComposition(doc)).toEqual([]);
	});
});
