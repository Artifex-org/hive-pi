/**
 * The transform whitelist — pure, total, no eval.
 *
 * These exist so a plan can reshape one node's output before the next node
 * consumes it WITHOUT that being a reason to reach for a barrier. "I need to
 * flatten/map/filter first" is the most common bogus justification for
 * synchronising a whole fan-out; a transform is a node like any other and does
 * not stop anything.
 *
 * Every op is total: given nonsense it returns something sensible rather than
 * throwing, because a transform failing mid-run would strand every dependent
 * node for a reason the model cannot see. Unknown ops ARE rejected, but that
 * happens in the validator, before anything runs.
 */

import type { TransformOp } from "./plan-schema.ts";

/** Read `a.b.c` out of a value. Returns undefined rather than throwing. */
export function getPath(value: unknown, path: string): unknown {
	if (!path) return value;
	let current: unknown = value;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function asArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value === null || value === undefined) return [];
	return [value];
}

function compare(left: unknown, right: unknown, test: string): boolean {
	switch (test) {
		case "eq":
			return left === right;
		case "neq":
			return left !== right;
		case "gt":
			return typeof left === "number" && typeof right === "number" && left > right;
		case "gte":
			return typeof left === "number" && typeof right === "number" && left >= right;
		case "lt":
			return typeof left === "number" && typeof right === "number" && left < right;
		case "lte":
			return typeof left === "number" && typeof right === "number" && left <= right;
		case "truthy":
			return Boolean(left);
		case "contains":
			if (typeof left === "string") return left.includes(String(right));
			if (Array.isArray(left)) return left.includes(right);
			return false;
		default:
			return false;
	}
}

/** Stable JSON for dedupe keys — key order must not change identity. */
function stableKey(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
}

export function applyTransform(input: unknown, op: TransformOp): unknown {
	switch (op.op) {
		case "dedupeBy": {
			const seen = new Set<string>();
			return asArray(input).filter((item) => {
				const key = op.keys.map((path) => stableKey(getPath(item, path))).join("\0");
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}

		case "filterBy":
			return asArray(input).filter((item) => compare(getPath(item, op.path), op.value, op.test));

		case "topN": {
			const items = [...asArray(input)];
			if (op.by) {
				const direction = op.dir === "asc" ? 1 : -1;
				items.sort((a, b) => {
					const left = getPath(a, op.by as string);
					const right = getPath(b, op.by as string);
					if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
					return String(left).localeCompare(String(right)) * direction;
				});
			}
			return items.slice(0, op.n);
		}

		case "groupBy": {
			const groups: Record<string, unknown[]> = {};
			for (const item of asArray(input)) {
				const key = String(getPath(item, op.key) ?? "undefined");
				(groups[key] ??= []).push(item);
			}
			return groups;
		}

		case "flatten":
			return asArray(input).flatMap((item) => (Array.isArray(item) ? item : [item]));

		case "pluck":
			return asArray(input).map((item) => getPath(item, op.path));

		case "count":
			return asArray(input).length;
	}
}
