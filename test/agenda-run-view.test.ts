/**
 * The live run view.
 *
 * Its job is to make silence distinguishable from progress. A multi-minute
 * `orchestrate` run is otherwise a frozen screen — the tool call blocks and the
 * workers are silent by construction — so a healthy 12-way fan-out looks
 * exactly like a wedged one. Every assertion here is about that distinction.
 */

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../extensions/agenda/executor.ts";
import { applyRunEvent, emptyRunView, renderRunLines, type RunView } from "../extensions/agenda/run-view.ts";

const T0 = 1_700_000_000_000;

function fold(events: RunEvent[], start = T0): RunView {
	return events.reduce(applyRunEvent, emptyRunView(start));
}

const started = (workId: string, nodeId: string, at: number): RunEvent => ({ at, ev: "node_started", workId, nodeId });
const finished = (workId: string, nodeId: string, at: number, tokens: number): RunEvent => ({
	at,
	ev: "node_finished",
	workId,
	nodeId,
	tokens,
});

describe("applyRunEvent", () => {
	it("tracks a node from started to done", () => {
		const view = fold([started("w1", "a", T0), finished("w1", "a", T0 + 5000, 120)]);
		expect(view.nodes).toHaveLength(1);
		expect(view.nodes[0]).toMatchObject({ nodeId: "a", state: "done", tokens: 120 });
	});

	it("accumulates spend across nodes", () => {
		const view = fold([
			started("w1", "a", T0),
			started("w2", "b", T0),
			finished("w1", "a", T0 + 1, 100),
			finished("w2", "b", T0 + 2, 50),
		]);
		expect(view.spentTokens).toBe(150);
	});

	it("records a failure with its reason", () => {
		const view = fold([started("w1", "a", T0), { at: T0 + 1, ev: "node_failed", workId: "w1", nodeId: "a", reason: "boom" }]);
		expect(view.nodes[0]).toMatchObject({ state: "failed", reason: "boom" });
	});

	it("records a halt", () => {
		const view = fold([{ at: T0, ev: "halted", reason: "budget" }]);
		expect(view.halted).toBe("budget");
	});

	it("ignores an event for an unknown work id rather than throwing", () => {
		// A view that crashes takes the run's tool call down with it.
		expect(() => fold([finished("ghost", "a", T0, 10)])).not.toThrow();
	});

	it("never mutates the view handed in", () => {
		const before = fold([started("w1", "a", T0)]);
		const after = applyRunEvent(before, finished("w1", "a", T0 + 1, 5));
		expect(before.nodes[0].state).toBe("running");
		expect(after.nodes[0].state).toBe("done");
	});
});

describe("renderRunLines", () => {
	it("leads with counts and spend", () => {
		const view = fold([started("w1", "a", T0), started("w2", "b", T0), finished("w1", "a", T0 + 1, 90)]);
		const head = renderRunLines(view, "my-plan", T0 + 2000)[0];
		expect(head).toContain("my-plan");
		expect(head).toContain("1 done");
		expect(head).toContain("1 running");
		expect(head).toContain("90 tokens");
	});

	it("CALLS OUT a node that has been silent too long", () => {
		// Silence and progress are otherwise identical on screen, which is the
		// whole reason this view exists.
		const view = fold([started("w1", "slow-node", T0)]);
		const lines = renderRunLines(view, "p", T0 + 200_000).join("\n");
		expect(lines).toContain("slow-node");
		expect(lines).toContain("no result for");
	});

	it("does not cry wolf on a node that is merely working", () => {
		const view = fold([started("w1", "fine", T0)]);
		expect(renderRunLines(view, "p", T0 + 5_000).join("\n")).not.toContain("no result for");
	});

	it("says it is scheduling when nothing is running but the run is not over", () => {
		// An empty panel reads as a freeze; naming the gap does not.
		const view = fold([started("w1", "a", T0), finished("w1", "a", T0 + 1, 10)]);
		expect(renderRunLines(view, "p", T0 + 2).join("\n")).toContain("scheduling next batch");
	});

	it("reports the halt reason", () => {
		const view = fold([{ at: T0, ev: "halted", reason: "budget" }]);
		expect(renderRunLines(view, "p", T0).join("\n")).toContain("HALTED: budget");
	});

	it("shows the total once finished, and stops saying it is scheduling", () => {
		const view = fold([
			started("w1", "a", T0),
			finished("w1", "a", T0 + 1000, 10),
			{ at: T0 + 2000, ev: "run_finished" },
		]);
		const lines = renderRunLines(view, "p", T0 + 3000).join("\n");
		expect(lines).toContain("finished in 2s");
		expect(lines).not.toContain("scheduling next batch");
	});

	it("caps the failure list so one bad stage cannot flood the panel", () => {
		const events: RunEvent[] = [];
		for (let i = 0; i < 20; i++) {
			events.push(started(`w${i}`, `n${i}`, T0));
			events.push({ at: T0 + 1, ev: "node_failed", workId: `w${i}`, nodeId: `n${i}`, reason: "boom" });
		}
		const failureLines = renderRunLines(fold(events), "p", T0 + 2).filter((l) => l.includes("✗"));
		expect(failureLines).toHaveLength(5);
	});
});
