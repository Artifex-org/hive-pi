/**
 * The injection ledger — pure, immutable, no I/O.
 *
 * Every automatic re-entry into the agent loop is charged here, keyed by an
 * opaque item id. This is the whole reason `agenda` is ONE extension: caps that
 * live in separate extensions multiply instead of composing, and pi builds a
 * fresh jiti per extension entry (`moduleCache:false`), so two extensions
 * cannot share this state at all.
 *
 * The read/record split is deliberate and preserves `verification-loop.ts`'s
 * exact ordering: the cap is tested BEFORE the expensive work runs, and the
 * counter only advances once that work has actually produced a failure. Fusing
 * them into one `tick()` would charge an item for a gate run that passed.
 */

export interface LedgerState {
	/** Injections charged per item id. Absent means zero. */
	readonly iterations: Readonly<Record<string, number>>;
}

export const emptyLedger: LedgerState = { iterations: {} };

export function count(ledger: LedgerState, id: string): number {
	return ledger.iterations[id] ?? 0;
}

/**
 * Has this item spent its budget? Checked before the policy does any work, so
 * an exhausted item costs nothing per settle.
 *
 * `max <= 0` disables the item entirely rather than granting it infinity — an
 * accidental `maxInjections: 0` in a repo config must fail closed.
 */
export function atCap(ledger: LedgerState, id: string, max: number): boolean {
	return count(ledger, id) >= max;
}

/** Charge one injection. Returns a new state; never mutates. */
export function record(ledger: LedgerState, id: string): LedgerState {
	return { iterations: { ...ledger.iterations, [id]: count(ledger, id) + 1 } };
}

/**
 * Zero one item — used when a policy's condition resolves (a gate goes green),
 * so the next genuine failure gets a full budget rather than a spent one.
 */
export function clear(ledger: LedgerState, id: string): LedgerState {
	if (!(id in ledger.iterations)) return ledger;
	const next = { ...ledger.iterations };
	delete next[id];
	return { iterations: next };
}

/** How many injections remain after the one just charged. Never negative. */
export function remaining(ledger: LedgerState, id: string, max: number): number {
	return Math.max(0, max - count(ledger, id));
}
