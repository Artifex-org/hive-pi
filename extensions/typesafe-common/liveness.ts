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
import { JEV_ROUTES, type JevRoute } from "./config.ts";

export interface Tally {
	/** The aggregate view, every route summed — what it was before there were routes. */
	counts: Record<OutcomeKind, number>;
	/**
	 * The same counts split by the route that produced them. `disabled` and
	 * client-side refusals tried no route and appear only in `counts`.
	 */
	byRoute: Record<JevRoute, Record<OutcomeKind, number>>;
	/** Outcomes served by a route other than the first configured one. */
	failovers: number;
	/** Of the `ok` calls, how many matched what the deterministic tier already said. */
	agreed: number;
	differed: number;
	/** Summed so a cost question has an answer without a second ledger. */
	inputTokens: number;
	/** USD as reported by the route (OpenRouter only), so spend moving onto that bill is visible. */
	costUsd: number;
	latenciesMs: number[];
}

function zeroCounts(): Record<OutcomeKind, number> {
	const counts = {} as Record<OutcomeKind, number>;
	for (const kind of OUTCOME_KINDS) counts[kind] = 0;
	return counts;
}

export function newTally(): Tally {
	const byRoute = {} as Record<JevRoute, Record<OutcomeKind, number>>;
	for (const route of JEV_ROUTES) byRoute[route] = zeroCounts();
	return {
		counts: zeroCounts(),
		byRoute,
		failovers: 0,
		agreed: 0,
		differed: 0,
		inputTokens: 0,
		costUsd: 0,
		latenciesMs: [],
	};
}

type OkOutcome<T> = Extract<Outcome<T>, { kind: "ok" }>;
type FailedOutcome<T> = Exclude<Outcome<T>, { kind: "ok" }>;

/**
 * Record one consultation.
 *
 * `agreedWithHeuristic` is REQUIRED when the outcome is `ok` and rejected
 * otherwise, and the overloads below are what make that true rather than
 * merely stated. A caller that recorded an `ok` without it would increment
 * `ok` and neither `agreed` nor `differed` — reproducing, inside the very
 * counter built to remove it, the ambiguity this file exists for. An earlier
 * draft had exactly that: the parameter optional and a comment claiming it was
 * not.
 */
export function record<T>(tally: Tally, outcome: OkOutcome<T>, agreedWithHeuristic: boolean): Tally;
export function record<T>(tally: Tally, outcome: FailedOutcome<T>): Tally;
export function record<T>(tally: Tally, outcome: Outcome<T>, agreedWithHeuristic?: boolean): Tally {
	tally.counts[outcome.kind] += 1;
	if (outcome.route !== null) tally.byRoute[outcome.route][outcome.kind] += 1;
	if (outcome.failover) tally.failovers += 1;
	if (outcome.kind === "ok") {
		tally.inputTokens += outcome.usage.inputTokens;
		tally.costUsd += outcome.usage.costUsd ?? 0;
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
	// Per route only once a route was tried; "via typesafe 40" on a healthy
	// day is the baseline that makes "via openrouter 40" readable as a cutover.
	const via = JEV_ROUTES.map((route) => [route, OUTCOME_KINDS.reduce((sum, k) => sum + tally.byRoute[route][k], 0)] as const)
		.filter(([, n]) => n > 0)
		.map(([route, n]) => `${route} ${n}`);
	if (via.length > 0) parts.push(`via ${via.join(" / ")}`);
	if (tally.failovers > 0) parts.push(`failover ${tally.failovers}`);
	if (tally.costUsd > 0) parts.push(`cost $${tally.costUsd.toFixed(6)}`);
	const p50 = median(tally.latenciesMs);
	if (p50 !== null) parts.push(`p50 ${Math.round(p50)}ms`);
	return `jev: ${parts.join(", ")}`;
}

/**
 * The per-route name for a consumer's metric: `drift-jev` → `drift-jev.openrouter`.
 * Both halves are fixed constants, never content, so the name stays inside
 * the metric bus's no-free-text rule. The base metric is still reported on
 * its own; this is the route dimension beside it, not a rename of it.
 */
export function routeMetricName(base: string, route: JevRoute): string {
	return `${base}.${route}`;
}
