/**
 * The policy-chain walk — the harness-neutral half of the driver.
 *
 * Lifted out of `driver.ts` so a harness that is not pi (the Claude adapter's
 * Stop hook, `claude/hooks/stop.ts`) runs the IDENTICAL loop rather than a
 * second reading of it. The rules it enforces, unchanged:
 *
 *   - walk the chain in fixed order, running each policy that wants the settle;
 *   - every policy that ran reports its own metric and applies its ledger;
 *   - continue past a policy with nothing to say — the gate applies on every
 *     settle in a gated repo, and stopping at the first policy that merely
 *     WANTS the settle would starve everything behind it;
 *   - stop at the first INJECTION: at most one per settle.
 *
 * Everything that depends on the host — whether the session is still the one
 * we started on, whether an injection is still welcome, where the status line
 * and the metric go — arrives as a callback, so this file holds no state.
 */

import type { LedgerState } from "./ledger.ts";
import type { MetricOutcome, Policy, PolicyContext } from "./policy.ts";

export interface ChainHost {
	/** Re-read after every await: false means the session was replaced or the run cancelled, and the walk ends silently. */
	stillCurrent(): boolean;
	/** Re-read before an injection is accepted: false drops it and ends the walk. */
	mayInject(): boolean;
	/** The transient status line. Optional: a headless host has none. */
	setStatus?(text: string): void;
	onMetric(name: string, outcome: MetricOutcome, value: number): void;
	ledger(): LedgerState;
	setLedger(next: LedgerState): void;
}

export interface ChainInjection {
	/** The policy that injected — `PolicyWork.name`. */
	policy: string;
	text: string;
}

/**
 * Walk `policies` once. Returns the one injection the settle produced, or null.
 *
 * `context` is everything a policy may read except the ledger, which is read
 * fresh for each policy so an earlier policy's charge is visible to the next.
 */
export async function walkChain(
	policies: readonly Policy[],
	context: Omit<PolicyContext, "ledger">,
	host: ChainHost,
): Promise<ChainInjection | null> {
	for (const policy of policies) {
		const work = policy.decide({ ...context, ledger: host.ledger() });
		if (!work) continue;

		if (work.status) host.setStatus?.(work.status);
		const outcome = await work.run();
		if (!host.stillCurrent()) return null; // replaced or cancelled mid-await
		host.setStatus?.("");

		host.onMetric(outcome.metric.name ?? work.name, outcome.metric.outcome, outcome.metric.value);

		if (outcome.ledger) host.setLedger(outcome.ledger(host.ledger()));
		if (!outcome.inject) continue; // nothing to say — let the next policy try

		// Re-checked LIVE: the policy's work is slow (a gate can run for
		// minutes) and the user may well have typed during it.
		if (!host.mayInject()) return null;
		return { policy: work.name, text: outcome.inject };
	}
	return null;
}
