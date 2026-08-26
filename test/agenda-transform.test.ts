/**
 * The transform whitelist.
 *
 * These exist so reshaping one node's output is never a reason to reach for a
 * barrier — "I need to flatten/filter first" is the most common bogus
 * justification for synchronising a whole fan-out.
 *
 * Every op must be TOTAL: given nonsense it returns something sensible rather
 * than throwing, because a transform failing mid-run would strand every
 * dependent node for a reason the model cannot see.
 */

import { describe, expect, it } from "vitest";
import { applyTransform, getPath } from "../extensions/agenda/transform.ts";

describe("getPath", () => {
	it("reads a nested path", () => {
		expect(getPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
	});
	it("returns the value itself for an empty path", () => {
		expect(getPath({ a: 1 }, "")).toEqual({ a: 1 });
	});
	it("returns undefined for a missing path rather than throwing", () => {
		expect(getPath({ a: 1 }, "x.y.z")).toBeUndefined();
	});
	it("survives a null in the middle", () => {
		expect(getPath({ a: null }, "a.b")).toBeUndefined();
	});
});

describe("dedupeBy", () => {
	it("keeps the first of each key", () => {
		const input = [
			{ file: "a.ts", line: 1 },
			{ file: "a.ts", line: 1 },
			{ file: "b.ts", line: 1 },
		];
		expect(applyTransform(input, { op: "dedupeBy", keys: ["file", "line"] })).toHaveLength(2);
	});

	it("is insensitive to key ORDER in nested values", () => {
		// Otherwise two identical findings serialised differently both survive.
		const input = [{ at: { line: 1, file: "a" } }, { at: { file: "a", line: 1 } }];
		expect(applyTransform(input, { op: "dedupeBy", keys: ["at"] })).toHaveLength(1);
	});

	it("treats a missing key as its own value rather than throwing", () => {
		const input = [{ a: 1 }, { b: 2 }, { c: 3 }];
		expect(applyTransform(input, { op: "dedupeBy", keys: ["missing"] })).toHaveLength(1);
	});
});

describe("filterBy", () => {
	const findings = [
		{ severity: "high", score: 9 },
		{ severity: "low", score: 2 },
		{ severity: "high", score: 7 },
	];

	it("eq", () => {
		expect(applyTransform(findings, { op: "filterBy", path: "severity", test: "eq", value: "high" })).toHaveLength(2);
	});
	it("gt", () => {
		expect(applyTransform(findings, { op: "filterBy", path: "score", test: "gt", value: 5 })).toHaveLength(2);
	});
	it("truthy needs no value", () => {
		const input = [{ ok: true }, { ok: false }, {}];
		expect(applyTransform(input, { op: "filterBy", path: "ok", test: "truthy" })).toHaveLength(1);
	});
	it("contains works on strings and arrays", () => {
		expect(
			applyTransform([{ t: "hello world" }], { op: "filterBy", path: "t", test: "contains", value: "world" }),
		).toHaveLength(1);
		expect(
			applyTransform([{ t: ["a", "b"] }], { op: "filterBy", path: "t", test: "contains", value: "b" }),
		).toHaveLength(1);
	});
	it("comparing a non-number with gt excludes rather than throws", () => {
		expect(applyTransform([{ s: "x" }], { op: "filterBy", path: "s", test: "gt", value: 1 })).toHaveLength(0);
	});
});

describe("topN", () => {
	const items = [{ n: 1 }, { n: 5 }, { n: 3 }];

	it("takes the first N when no sort key is given", () => {
		expect(applyTransform(items, { op: "topN", n: 2 })).toEqual([{ n: 1 }, { n: 5 }]);
	});
	it("sorts descending by default", () => {
		expect(applyTransform(items, { op: "topN", n: 2, by: "n" })).toEqual([{ n: 5 }, { n: 3 }]);
	});
	it("sorts ascending on request", () => {
		expect(applyTransform(items, { op: "topN", n: 2, by: "n", dir: "asc" })).toEqual([{ n: 1 }, { n: 3 }]);
	});
	it("returns everything when N exceeds the input", () => {
		expect(applyTransform(items, { op: "topN", n: 99 })).toHaveLength(3);
	});
});

describe("groupBy / flatten / pluck / count", () => {
	it("groups by a key", () => {
		const input = [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "a", v: 3 }];
		const grouped = applyTransform(input, { op: "groupBy", key: "k" }) as Record<string, unknown[]>;
		expect(Object.keys(grouped).sort()).toEqual(["a", "b"]);
		expect(grouped.a).toHaveLength(2);
	});

	it("names a missing group rather than dropping its items", () => {
		const grouped = applyTransform([{ v: 1 }], { op: "groupBy", key: "k" }) as Record<string, unknown[]>;
		expect(grouped.undefined).toHaveLength(1);
	});

	it("flattens one level", () => {
		expect(applyTransform([[1, 2], [3], 4], { op: "flatten" })).toEqual([1, 2, 3, 4]);
	});

	it("plucks a path from each element", () => {
		expect(applyTransform([{ a: 1 }, { a: 2 }], { op: "pluck", path: "a" })).toEqual([1, 2]);
	});

	it("counts", () => {
		expect(applyTransform([1, 2, 3], { op: "count" })).toBe(3);
	});
});

describe("totality — nonsense in, something sensible out", () => {
	it.each([
		[null, { op: "count" as const }, 0],
		[undefined, { op: "count" as const }, 0],
	])("%o survives", (input, op, expected) => {
		expect(applyTransform(input, op)).toBe(expected);
	});

	it("wraps a non-array input rather than failing", () => {
		expect(applyTransform("single", { op: "flatten" })).toEqual(["single"]);
	});

	it("dedupes a scalar input without throwing", () => {
		expect(applyTransform(42, { op: "dedupeBy", keys: ["x"] })).toEqual([42]);
	});
});
