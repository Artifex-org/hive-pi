/**
 * The policy contract.
 *
 * A policy is offered every settle. It answers one question synchronously —
 * "do I want this settle?" — and only then is its expensive work run. That
 * split is what keeps the common case (no policy applies) at roughly zero cost,
 * which matters because pi awaits extension handlers SERIALLY: whatever the
 * driver does on settle sits in front of `hive-telemetry`'s flush.
 *
 * `decide()` must not do I/O beyond a cheap config read, must not await, and
 * must not touch `ctx` — the driver has already read everything needed off
 * `ctx` before its first await, because `ctx` throws once the session is
 * replaced.
 */

import type { LedgerState } from "./ledger.ts";
import type { SessionSignals } from "./signals.ts";

/** The four values `hive-telemetry` will actually fold. Anything else is silently dropped by `foldGate`'s `default: return` (accumulator.ts). */
export type MetricOutcome = "pass" | "fail" | "timeout" | "skip";

export interface PolicyOutcome {
	/** Reported on the bus as `hive.metric`. Numbers and enums only — never free text. */
	metric: { outcome: MetricOutcome; value: number };
	/** Text to inject as a follow-up turn. Absent means "nothing to say". */
	inject?: string;
	/** Applied to the ledger after the work completes. */
	ledger?: (state: LedgerState) => LedgerState;
	/** Replaces the transient status line; the driver always clears it afterwards. */
	status?: string;
}

export interface PolicyWork {
	/** Stable name — used for `hive.metric.name` and in `/agenda`. */
	name: string;
	/** Shown via `ctx.ui.setStatus` while `run()` is in flight. */
	status: string;
	/** The expensive part. Runs off the handler's synchronous path. */
	run(): Promise<PolicyOutcome>;
}

export interface PolicyContext {
	cwd: string;
	ledger: LedgerState;
	/** Text of the most recent assistant turn, for the question guard. */
	lastAssistantText: string | undefined;
	/**
	 * Recent conversation text, oldest first, for policies that need to grade
	 * what happened rather than just react to the last line.
	 *
	 * Read off `ctx` by the driver before its first await, like everything else —
	 * a policy must never reach for `ctx` itself, because by the time its
	 * `run()` resolves the session may have been replaced.
	 */
	transcript: string;
	/**
	 * Precomputed session signals (todo counts, plan phase, last user prompt),
	 * derived by the driver in the same before-first-await block as everything
	 * else. Optional so tests that hand-build a context for the gate or the
	 * goal do not have to fabricate them; a policy that needs signals treats
	 * absence as "not my settle".
	 */
	signals?: SessionSignals;
}

export interface Policy {
	name: string;
	/** Synchronous, cheap, no `ctx`. Returns null when this policy does not want this settle. */
	decide(context: PolicyContext): PolicyWork | null;
}
