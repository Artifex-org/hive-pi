/**
 * Reading pi's usage off the wire — one accumulator, pure.
 *
 * ## The trap this file exists to hold
 *
 * `usage.cost` is an OBJECT, not a number:
 *
 * ```json
 * "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
 *            "totalTokens": 0,
 *            "cost": { "input": 0, "output": 0, "cacheRead": 0,
 *                      "cacheWrite": 0, "total": 0 } }
 * ```
 *
 * Every wrong way to read it fails SILENTLY as zero spend, which is the worst
 * shape a billing bug can take — a run that cost real money reports free, and
 * nothing anywhere looks broken:
 *
 *   * `Number(usage.cost)` → `NaN` → coerced to `null`/0 downstream. This one
 *     shipped in the Aurora agent sidecar and was only caught by running the
 *     container; `tsc` accepted it, because `Number()` accepts anything.
 *   * `usage.cost ?? 0` → the OBJECT, so `+=` yields `"[object Object]"` or NaN.
 *   * Typing usage as `Record<string, number>` — which `rpc-protocol.ts` did —
 *     makes the compiler agree that `cost` is a number and describe the wire
 *     incorrectly. The field is then quietly dropped rather than misread, so
 *     the run reports zero dollars and no test fails.
 *
 * The only correct read is `usage.cost.total`.
 *
 * ## Why tokens and cost are both kept
 *
 * They are not interchangeable, and a plan may set `model` PER NODE. A fanout
 * of cheap flash workers plus one expensive judge has wildly different cost per
 * token, so a token budget does not bound spend and a dollar figure cannot be
 * derived from tokens after the fact. Both come off the same event; keep both.
 *
 * Nothing mutable at module scope — pi builds a fresh jiti per extension entry.
 */

/** The wire shape, as measured against the pinned 0.83.0. */
export interface WireCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

export interface WireUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	/** An OBJECT. See the header. */
	cost?: WireCost;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Dollars. */
	cost: number;
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * A finite number, or 0.
 *
 * Guards the case the header describes: if a future pi flattens `cost` to a
 * number, or a field arrives as a string, this yields 0 rather than poisoning
 * the running total with NaN. A single NaN is unrecoverable — it makes every
 * subsequent addition NaN, so one malformed event would erase a whole run's
 * accounting.
 */
function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Fold one event's usage into a running total. Returns a NEW total. */
export function addUsage(total: Usage, wire: WireUsage | undefined): Usage {
	if (!wire) return total;
	return {
		input: total.input + num(wire.input),
		output: total.output + num(wire.output),
		cacheRead: total.cacheRead + num(wire.cacheRead),
		cacheWrite: total.cacheWrite + num(wire.cacheWrite),
		cost: total.cost + num(wire.cost?.total),
	};
}

export function addTotals(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

/**
 * Tokens that count against a budget.
 *
 * Deliberately input + output, excluding cache reads/writes: the existing
 * `budgetTokens` cap has always meant this, and silently widening it would
 * shrink every plan's effective budget without anyone changing a number.
 */
export function budgetTokens(usage: Usage): number {
	return usage.input + usage.output;
}

/** `$1.2345`, or empty when nothing was spent — never `$0.0000`, which reads as a measurement. */
export function formatCost(cost: number): string {
	return cost > 0 ? `$${cost.toFixed(4)}` : "";
}
