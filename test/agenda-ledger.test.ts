/**
 * The ledger is the only thing bounding automatic re-entry, so it is tested as
 * a pure fold: no pi, no processes, no clock.
 */

import { describe, expect, it } from "vitest";
import { atCap, clear, count, emptyLedger, record, remaining } from "../extensions/agenda/ledger.ts";

describe("ledger — counting", () => {
	it("reports zero for an item it has never seen", () => {
		expect(count(emptyLedger, "gate:/repo")).toBe(0);
	});

	it("charges one injection at a time", () => {
		let l = emptyLedger;
		l = record(l, "a");
		l = record(l, "a");
		expect(count(l, "a")).toBe(2);
	});

	it("keeps items independent", () => {
		let l = record(emptyLedger, "a");
		l = record(l, "a");
		l = record(l, "b");
		expect(count(l, "a")).toBe(2);
		expect(count(l, "b")).toBe(1);
	});

	it("never mutates the state handed in", () => {
		const before = record(emptyLedger, "a");
		const after = record(before, "a");
		expect(count(before, "a")).toBe(1);
		expect(count(after, "a")).toBe(2);
	});
});

describe("ledger — the cap", () => {
	it("is not at cap below the maximum", () => {
		const l = record(emptyLedger, "a");
		expect(atCap(l, "a", 3)).toBe(false);
	});

	it("is at cap exactly at the maximum, not one past it", () => {
		let l = record(emptyLedger, "a");
		l = record(l, "a");
		expect(atCap(l, "a", 2)).toBe(true);
	});

	it("fails CLOSED on a zero or negative maximum", () => {
		// An accidental `maxInjections: 0` in a repo config must disable the
		// policy, never grant it an unbounded budget.
		expect(atCap(emptyLedger, "a", 0)).toBe(true);
		expect(atCap(emptyLedger, "a", -1)).toBe(true);
	});
});

describe("ledger — clearing", () => {
	it("zeroes one item and leaves the rest alone", () => {
		let l = record(emptyLedger, "a");
		l = record(l, "b");
		l = clear(l, "a");
		expect(count(l, "a")).toBe(0);
		expect(count(l, "b")).toBe(1);
	});

	it("is a no-op for an unknown item, returning the same object", () => {
		const l = record(emptyLedger, "a");
		expect(clear(l, "nope")).toBe(l);
	});

	it("restores the full budget", () => {
		let l = record(emptyLedger, "a");
		l = record(l, "a");
		expect(atCap(l, "a", 2)).toBe(true);
		l = clear(l, "a");
		expect(atCap(l, "a", 2)).toBe(false);
	});
});

describe("ledger — remaining", () => {
	it("counts down as injections are charged", () => {
		let l = emptyLedger;
		expect(remaining(l, "a", 3)).toBe(3);
		l = record(l, "a");
		expect(remaining(l, "a", 3)).toBe(2);
		l = record(l, "a");
		l = record(l, "a");
		expect(remaining(l, "a", 3)).toBe(0);
	});

	it("never goes negative, even past the cap", () => {
		let l = emptyLedger;
		for (let i = 0; i < 10; i++) l = record(l, "a");
		expect(remaining(l, "a", 3)).toBe(0);
	});
});
