/**
 * Remaining subscription allowance (HIV-2086).
 *
 * `DashboardService/GetCurrentPeriodUsage` is a unary JSON call returning the
 * account's spend against its included pool, in CENTS:
 *
 *   {"billingCycleStart":"…","billingCycleEnd":"…",
 *    "planUsage":{"totalSpend":1245,"includedSpend":1245,"remaining":755,
 *                 "limit":2000,"totalPercentUsed":3.61},
 *    "displayMessage":"You've used 62% of your included usage"}
 *
 * Why this matters more than it looks: hive's `orderByQuota` re-orders a
 * credential chain ONLY when every credential in it has a usable reading — a
 * single unknown disables re-ordering for the whole chain. A quota-blind
 * provider dropped in beside Codex would therefore silently switch OFF the
 * auto-switching that already works. Cursor is not that provider.
 *
 * And unlike the Codex quota probe — which spends the very allowance it
 * measures, forcing a 70-minute poll interval — this one is FREE, so it can be
 * polled on the cheap cadence.
 *
 * `planUsage.totalPercentUsed` is deliberately NOT used: it disagreed with the
 * cents on a live account (3.61 while `displayMessage` said 62% used), because
 * it is a blended figure across pools. `remaining`/`limit` are the fields that
 * reconcile.
 */

import { cursorHeaders } from "./transport.ts";

const API = "https://api2.cursor.sh";
const USAGE_PATH = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export interface CursorUsage {
	/** Cents remaining in the included pool. */
	remainingCents: number;
	/** Cents included per period. */
	limitCents: number;
	/** 0-100, rounded. What hive stores as `quota_remaining_percent`. */
	remainingPercent: number;
	/** Cursor's own sentence, worth surfacing verbatim in an operator UI. */
	message: string;
	billingCycleEnd: Date | null;
}

export async function fetchUsage(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<CursorUsage> {
	const res = await fetchImpl(`${API}${USAGE_PATH}`, {
		method: "POST",
		headers: {
			...cursorHeaders(accessToken),
			"content-type": "application/json",
			"connect-protocol-version": "1",
		},
		body: "{}",
	});
	if (!res.ok) {
		throw new Error(`Cursor usage failed: HTTP ${res.status} ${await res.text()}`);
	}
	return parseUsage(await res.json());
}

/** Split from the fetch so the arithmetic is testable without a network. */
export function parseUsage(body: unknown): CursorUsage {
	const b = (body ?? {}) as {
		planUsage?: { remaining?: number; limit?: number };
		displayMessage?: string;
		billingCycleEnd?: string;
	};
	const limitCents = Number(b.planUsage?.limit ?? 0);
	const remainingCents = Number(b.planUsage?.remaining ?? 0);

	// A zero or missing limit means we cannot express a percentage. Report 0 —
	// NOT 100 — because "we could not measure" must never read as "plenty left":
	// that is the reading that would route the whole fleet onto a dead account.
	const remainingPercent =
		limitCents > 0 ? Math.max(0, Math.min(100, Math.round((remainingCents / limitCents) * 100))) : 0;

	const endMs = Number(b.billingCycleEnd);
	return {
		remainingCents,
		limitCents,
		remainingPercent,
		message: b.displayMessage ?? "",
		billingCycleEnd: Number.isFinite(endMs) && endMs > 0 ? new Date(endMs) : null,
	};
}
