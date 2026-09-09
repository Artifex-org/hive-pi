/**
 * Which compactions get replaced by a clean break — the safety half of HIV-3388.
 *
 * The `false` cases matter far more than the `true` one. Cancelling a
 * compaction that the session actually needed converts a recoverable session
 * into a dead one, and the overflow case is the sharp edge: by the time pi
 * reports `reason: "overflow"` the session is ALREADY past the provider's hard
 * limit, every further request is refused, and each refusal leaves the context
 * larger than the last (HIV-3060 — measured at 15.5 hours burned, one session
 * issuing eleven identical 400s over 12h27m). Compaction is the only thing that
 * can still rescue it.
 *
 * So if someone later "simplifies" this predicate to `reason !== "manual"`, the
 * overflow test below is what fails.
 */

import { describe, expect, it } from "vitest";
import { shouldHandoffInsteadOfCompact } from "../extensions/agenda/handoff.ts";

const on = { isWorker: false, enabled: true } as const;

describe("shouldHandoffInsteadOfCompact", () => {
	it("replaces a THRESHOLD compaction — the only case it exists for", () => {
		expect(shouldHandoffInsteadOfCompact({ reason: "threshold", ...on })).toBe(true);
	});

	it("NEVER touches an overflow compaction, which is the session's only rescue", () => {
		expect(shouldHandoffInsteadOfCompact({ reason: "overflow", ...on })).toBe(false);
	});

	it("does not override a compaction the operator asked for", () => {
		expect(shouldHandoffInsteadOfCompact({ reason: "manual", ...on })).toBe(false);
	});

	it("is inert in a worker, which has no successor session to seed", () => {
		for (const reason of ["threshold", "overflow", "manual"] as const) {
			expect(shouldHandoffInsteadOfCompact({ reason, isWorker: true, enabled: true })).toBe(false);
		}
	});

	it("is inert while the flag is off, for every reason", () => {
		// The default. Ending a session that still holds work needs a successor,
		// and nothing yet starts one for context exhaustion.
		for (const reason of ["threshold", "overflow", "manual"] as const) {
			expect(shouldHandoffInsteadOfCompact({ reason, isWorker: false, enabled: false })).toBe(false);
		}
	});
});
