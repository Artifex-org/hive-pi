/**
 * Context pressure: a truthful meter, and a suggestion at the boundary (HIV-3173).
 *
 * Two halves of one property. The meter has to REPORT what the harness knows —
 * HIV-2984 measured a session at 152% of its window while the cell read a flat
 * `100%` next to an unclamped `283k/272k`, so the two halves of one cell
 * disagreed and the half worth acting on was the half being hidden. And the
 * suggestion has to fire where a clean break is actually cheaper than a
 * compaction, which HIV-1231 says is a phase BOUNDARY and nowhere else.
 */

import { describe, expect, it } from "vitest";
import { contextCell } from "../extensions/status-footer/render.ts";
import { CONTEXT_PRESSURE_PERCENT, renderConductorLines, suggestsHandoff } from "../extensions/agenda/conductor.ts";
import { createConductor, withStage } from "../extensions/agenda/conductor-state.ts";
import { contextSignalOf, emptyContextSignal, type ContextSignal } from "../extensions/agenda/signals.ts";

const plain = { fg: (_color: string, text: string) => text };
const signal = (percent: number | null, tokens: number | null = 1000, window = 272_000): ContextSignal => ({
	tokens,
	window,
	percent,
});

describe("contextCell — the number is not clamped, the bar is", () => {
	it("reports a session over its window as over its window", () => {
		// The exact reading from HIV-2984. Before this, the cell said "100%".
		const cell = contextCell({ tokens: 413_000, percent: 152 }, 272_000, plain);
		expect(cell).toContain("152%");
		expect(cell).not.toContain("100%");
	});

	it("still draws a full bar and no more — ten characters cannot show 152%", () => {
		const over = contextCell({ tokens: 413_000, percent: 152 }, 272_000, plain);
		const full = contextCell({ tokens: 272_000, percent: 100 }, 272_000, plain);
		expect(over).toContain("█".repeat(10));
		expect(over).not.toContain("█".repeat(11));
		// The bar saturates while the number keeps moving — that is the point.
		expect(full).toContain("█".repeat(10));
		expect(full).toContain("100%");
	});

	it("colours on the true value, so past the wall never reads as healthy", () => {
		const themed = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
		expect(contextCell({ tokens: 1, percent: 152 }, 272_000, themed)).toContain("<error>152%</error>");
		expect(contextCell({ tokens: 1, percent: 50 }, 272_000, themed)).toContain("<success>50%</success>");
	});

	it("renders unknown as a question mark, never as zero", () => {
		// The documented post-compaction state. A confident 0% there is a lie.
		expect(contextCell({ tokens: null, percent: null }, 272_000, plain)).toBe("ctx ?");
		expect(contextCell(null, 272_000, plain)).toBe("ctx ?");
		expect(contextCell({ tokens: 1, percent: 10 }, undefined, plain)).toBe("ctx ?");
	});

	it("compact mode carries the number too", () => {
		expect(contextCell({ tokens: 413_000, percent: 152 }, 272_000, plain, true)).toContain("152%");
	});
});

describe("contextSignalOf", () => {
	it("passes a real reading through unclamped", () => {
		expect(contextSignalOf({ tokens: 413_000, contextWindow: 272_000, percent: 152 })).toEqual({
			tokens: 413_000,
			window: 272_000,
			percent: 152,
		});
	});

	it("treats a missing or zero window as unknown, not as a ratio over zero", () => {
		expect(contextSignalOf(null)).toEqual(emptyContextSignal);
		expect(contextSignalOf(undefined)).toEqual(emptyContextSignal);
		expect(contextSignalOf({ tokens: 10, contextWindow: 0, percent: 50 })).toEqual(emptyContextSignal);
	});

	it("drops non-finite numbers rather than propagating them", () => {
		const s = contextSignalOf({ tokens: Number.NaN, contextWindow: 272_000, percent: Number.POSITIVE_INFINITY });
		expect(s.percent).toBeNull();
		expect(s.tokens).toBeNull();
		expect(s.window).toBe(272_000);
	});
});

describe("suggestsHandoff — the boundary is the selective term", () => {
	it("fires at a lifecycle boundary under pressure", () => {
		expect(suggestsHandoff("verify", signal(CONTEXT_PRESSURE_PERCENT))).toBe(true);
		expect(suggestsHandoff("consolidate", signal(90))).toBe(true);
	});

	it("does NOT fire mid-phase, however high the pressure", () => {
		// The contract HIV-1231 actually specified: a clean break belongs at a
		// phase boundary. Firing at 152% during execute would interrupt exactly
		// the work a handoff is supposed to hand over intact.
		expect(suggestsHandoff("execute", signal(152))).toBe(false);
		expect(suggestsHandoff("frame", signal(152))).toBe(false);
		expect(suggestsHandoff("plan", signal(152))).toBe(false);
	});

	it("does not fire below the threshold", () => {
		expect(suggestsHandoff("verify", signal(CONTEXT_PRESSURE_PERCENT - 1))).toBe(false);
	});

	it("treats unknown pressure as no-fire, not as zero and not as high", () => {
		// Also what stops a suggestion firing in the moment right after the
		// compaction that just relieved the pressure: percent is null until the
		// next assistant response.
		expect(suggestsHandoff("verify", signal(null))).toBe(false);
		expect(suggestsHandoff("verify", null)).toBe(false);
		expect(suggestsHandoff("verify", undefined)).toBe(false);
		expect(suggestsHandoff("verify", emptyContextSignal)).toBe(false);
	});

	it("honours an explicit threshold", () => {
		expect(suggestsHandoff("verify", signal(50), 40)).toBe(true);
		expect(suggestsHandoff("verify", signal(50), 60)).toBe(false);
	});
});

describe("renderConductorLines — the suggestion reaches the operator", () => {
	const verify = withStage(createConductor("c", 0), "verify", 0);

	it("adds one line naming /handoff when pressure is high at the boundary", () => {
		const lines = renderConductorLines(verify, null, true, signal(88)) ?? [];
		const suggestion = lines.find((line) => line.includes("/handoff"));
		expect(suggestion).toBeDefined();
		expect(suggestion).toContain("88%");
	});

	it("says nothing when the pressure is low, unknown, or absent", () => {
        const has = (context: ContextSignal | null | undefined) =>
			(renderConductorLines(verify, null, true, context) ?? []).some((line) => line.includes("/handoff"));
		expect(has(signal(20))).toBe(false);
		expect(has(signal(null))).toBe(false);
		expect(has(null)).toBe(false);
		expect(has(undefined)).toBe(false);
	});

	it("leaves the existing widget contract untouched", () => {
		// Disabled / idle / done still render nothing, pressure or not.
		expect(renderConductorLines(createConductor("c", 0), null, true, signal(152))).toBeNull();
		expect(renderConductorLines(withStage(createConductor("c", 0), "done", 0), null, true, signal(152))).toBeNull();
		expect(renderConductorLines(verify, null, false, signal(152))).toBeNull();
		// And the stage's own line is still there beside the new one.
		const lines = renderConductorLines(verify, null, true, signal(152)) ?? [];
		expect(lines.some((line) => line.includes("running delivery checks"))).toBe(true);
	});
});
