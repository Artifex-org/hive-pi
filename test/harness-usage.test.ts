/**
 * The usage accumulator, and specifically the shape of `usage.cost`.
 *
 * Every wrong way to read that field fails as ZERO SPEND rather than as an
 * error, so these tests exist to make the wire shape a thing that is asserted
 * rather than remembered. The payload below is copied from a live
 * `pi --mode json` run against the pinned 0.83.0.
 */

import { describe, expect, it } from "vitest";
import { addTotals, addUsage, budgetTokens, emptyUsage, formatCost } from "../extensions/harness/usage.ts";

/** Verbatim from a real `message_end`. `cost` is an OBJECT. */
const WIRE = {
	input: 1200,
	output: 300,
	cacheRead: 40,
	cacheWrite: 10,
	totalTokens: 1550,
	cost: { input: 0.0012, output: 0.0009, cacheRead: 0, cacheWrite: 0, total: 0.0021 },
};

describe("addUsage", () => {
	it("reads dollars from cost.total", () => {
		expect(addUsage(emptyUsage(), WIRE).cost).toBeCloseTo(0.0021, 10);
	});

	it("accumulates across events", () => {
		const total = addUsage(addUsage(emptyUsage(), WIRE), WIRE);
		expect(total.input).toBe(2400);
		expect(total.output).toBe(600);
		expect(total.cost).toBeCloseTo(0.0042, 10);
	});

	it("is a no-op for an event with no usage", () => {
		expect(addUsage(emptyUsage(), undefined)).toEqual(emptyUsage());
	});

	it("survives a cost object with no total", () => {
		const partial = { input: 5, cost: { input: 0.5 } };
		expect(addUsage(emptyUsage(), partial).cost).toBe(0);
		expect(addUsage(emptyUsage(), partial).input).toBe(5);
	});

	it("NEVER yields NaN, whatever the field turns out to be", () => {
		// One NaN is unrecoverable: it makes every later addition NaN, so a single
		// malformed event would erase a whole run's accounting.
		const hostile = [
			{ cost: 0.5 as unknown as { total?: number } }, // a future pi flattens it
			{ cost: { total: "0.5" as unknown as number } }, // a string
			{ cost: { total: Number.NaN } },
			{ cost: { total: Number.POSITIVE_INFINITY } },
			{ input: "many" as unknown as number },
		];
		for (const wire of hostile) {
			const total = addUsage(emptyUsage(), wire);
			expect(Number.isFinite(total.cost)).toBe(true);
			expect(Number.isFinite(total.input)).toBe(true);
		}
	});

	it("does not silently coerce the cost OBJECT into a number", () => {
		// The bug this guards: `Number(usage.cost)` is NaN, and `usage.cost ?? 0`
		// is the object itself. Both book a paid run as free.
		expect(Number(WIRE.cost)).toBeNaN();
		expect(addUsage(emptyUsage(), WIRE).cost).toBe(0.0021);
	});
});

describe("budgetTokens", () => {
	it("counts input + output only", () => {
		// Deliberately excludes cache reads/writes: `budgetTokens` has always
		// meant this, and widening it would shrink every existing plan's budget
		// without anyone changing a number.
		expect(budgetTokens(addUsage(emptyUsage(), WIRE))).toBe(1500);
	});
});

describe("addTotals", () => {
	it("merges two accumulated totals", () => {
		const one = addUsage(emptyUsage(), WIRE);
		const merged = addTotals(one, one);
		expect(merged.input).toBe(2400);
		expect(merged.cost).toBeCloseTo(0.0042, 10);
	});
});

describe("formatCost", () => {
	it("renders dollars to four places", () => {
		expect(formatCost(0.0021)).toBe("$0.0021");
	});

	it("renders nothing at zero", () => {
		// `$0.0000` reads as a measurement — "this run was free" — when it usually
		// means the provider reported no cost. Absence is the honest rendering.
		expect(formatCost(0)).toBe("");
	});
});
