/**
 * typesafe-common — the liveness surface.
 *
 * ## HIV-712, which is the entire reason this file exists
 *
 * A classifier behind a deterministic fallback has a failure mode with no
 * symptom. If the call times out, or the key is missing, or the answer is
 * malformed, the fallback fires and returns the heuristic's answer — which is
 * also what happens when the classifier runs and AGREES. The two are
 * indistinguishable from the outside. HIV-712 is the recorded case: 48 fallback
 * log lines, all present, none read, and the feature had been dead for weeks.
 *
 * A log line is not a surface. A COUNTER that a command can print is. So every
 * seam that consults Jev records its outcome kind here, and separates the two
 * `ok` cases — agreed with the heuristic, or differed from it. Then:
 *
 *   - `ok: 0`  with `disabled: 40`  — never switched on.
 *   - `ok: 0`  with `timeout: 40`   — switched on, unreachable.
 *   - `ok: 0`  with `malformed: 40` — reachable, answering nothing usable.
 *   - `ok: 40, agreed: 40`          — working, and adding nothing.
 *   - `ok: 40, differed: 11`        — working, and doing something.
 *
 * The last two are the only ones the old log-line shape could tell apart from
 * the first three, and only by reading 48 lines.
 */

import { OUTCOME_KINDS, type Outcome, type OutcomeKind } from "./client.ts";

export interface Tally {
	counts: Record<OutcomeKind, number>;
	/** Of the `ok` calls, how many matched what the deterministic tier already said. */
	agreed: number;
	differed: number;
	/** Summed so a cost question has an answer without a second ledger. */
	inputTokens: number;
	latenciesMs: number[];
}

export function newTally(): Tally {
	const counts = {} as Record<OutcomeKind, number>;
	for (const kind of OUTCOME_KINDS) counts[kind] = 0;
	return { counts, agreed: 0, differed: 0, inputTokens: 0, latenciesMs: [] };
}

/**
 * Record one consultation.
 *
 * `agreedWithHeuristic` is deliberately required-when-ok rather than optional:
 * a caller that forgets it produces the exact ambiguity this file exists to
 * remove, and leaving it optional would let that happen silently.
 */
export function record<T>(tally: Tally, outcome: Outcome<T>, agreedWithHeuristic?: boolean): Tally {
	tally.counts[outcome.kind] += 1;
	if (outcome.kind === "ok") {
		tally.inputTokens += outcome.usage.inputTokens;
		tally.latenciesMs.push(outcome.latencyMs);
		if (agreedWithHeuristic === true) tally.agreed += 1;
		else if (agreedWithHeuristic === false) tally.differed += 1;
	}
	return tally;
}

/** Total consultations, however they ended. Zero means "never called". */
export function totalCalls(tally: Tally): number {
	return OUTCOME_KINDS.reduce((sum, kind) => sum + tally.counts[kind], 0);
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One line, for a status command or a replay report.
 *
 * Non-zero kinds only, EXCEPT `ok`, which is printed even at zero — "ok 0" is
 * the sentence a reader needs to see, and hiding it because it is empty is how
 * the HIV-712 shape comes back.
 */
export function formatTally(tally: Tally): string {
	const total = totalCalls(tally);
	if (total === 0) return "jev: never called";
	const parts = [`ok ${tally.counts.ok}/${total}`];
	for (const kind of OUTCOME_KINDS) {
		if (kind !== "ok" && tally.counts[kind] > 0) parts.push(`${kind} ${tally.counts[kind]}`);
	}
	if (tally.agreed + tally.differed > 0) parts.push(`agreed ${tally.agreed}`, `differed ${tally.differed}`);
	const p50 = median(tally.latenciesMs);
	if (p50 !== null) parts.push(`p50 ${Math.round(p50)}ms`);
	return `jev: ${parts.join(", ")}`;
}
