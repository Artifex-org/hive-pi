/**
 * Plan-limit billing guard (docs/claude-sdk-compatibility.md §Usage credits).
 * A Claude SDK turn must draw from the subscription's plan limits. The pinned
 * CLI reports each response's rate-limit headers as a `rate_limit_event`; a
 * turn it reports as billed to usage credits (extra usage) fails, so Pi issues
 * no further charged turns. There is no opt-in: the transport has no paid path.
 */
import type { JsonObject } from "@earendil-works/pi-ai";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { known, SdkProviderError } from "./events.ts";

type Status = SDKRateLimitInfo["status"];
type Window = NonNullable<SDKRateLimitInfo["rateLimitType"]>;
type DisabledReason = NonNullable<SDKRateLimitInfo["overageDisabledReason"]>;
/** The pinned SDK's `SDKRateLimitInfo` enums; any other value is reported as "unrecognized". */
const statuses = ["allowed", "allowed_warning", "rejected"] as const satisfies readonly Status[];
const windows = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"] as const satisfies readonly Window[];
const disabledReasons = ["overage_not_provisioned", "org_level_disabled", "org_level_disabled_until", "out_of_credits", "seat_tier_level_disabled",
	"member_level_disabled", "seat_tier_zero_credit_limit", "group_zero_credit_limit", "member_zero_credit_limit", "org_service_level_disabled",
	"no_limits_configured", "fetch_error", "unknown"] as const satisfies readonly DisabledReason[];

/** The allowlisted fields of one `rate_limit_info`, safe to copy into diagnostics. */
export interface RateLimitSnapshot {
	status?: Status | "unrecognized";
	rateLimitType?: Window | "unrecognized";
	utilization?: number;
	resetsAt?: number;
	overageStatus?: Status | "unrecognized";
	overageDisabledReason?: DisabledReason | "unrecognized";
	isUsingOverage?: boolean;
	overageInUse?: boolean;
}

/** Enumerated values only when known, finite counters, booleans as booleans; nothing else is copied. */
export function rateLimitSnapshot(info: unknown): RateLimitSnapshot | undefined {
	if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
	const raw = info as Record<string, unknown>;
	const snapshot: RateLimitSnapshot = {
		status: known(statuses, raw.status),
		rateLimitType: known(windows, raw.rateLimitType),
		utilization: typeof raw.utilization === "number" && Number.isFinite(raw.utilization) && raw.utilization >= 0 ? raw.utilization : undefined,
		resetsAt: typeof raw.resetsAt === "number" && Number.isSafeInteger(raw.resetsAt) && raw.resetsAt > 0 ? raw.resetsAt : undefined,
		overageStatus: known(statuses, raw.overageStatus),
		overageDisabledReason: known(disabledReasons, raw.overageDisabledReason),
		isUsingOverage: typeof raw.isUsingOverage === "boolean" ? raw.isUsingOverage : undefined,
		overageInUse: typeof raw.overageInUse === "boolean" ? raw.overageInUse : undefined,
	};
	return Object.values(snapshot).some(value => value !== undefined) ? snapshot : undefined;
}

/** The snapshot's present fields, as a diagnostic value. */
export function rateLimitDetails(snapshot: RateLimitSnapshot): JsonObject {
	const details: JsonObject = {};
	for (const [key, value] of Object.entries(snapshot)) if (value !== undefined) details[key] = value;
	return details;
}

/**
 * The pinned CLI's own classification (2.1.308): it records a query as
 * `billedToUsageCredits` when `overageInUse` is true, and treats
 * `isUsingOverage` as overage except on the `seven_day_overage_included` window.
 */
export function billedToUsageCredits(snapshot: RateLimitSnapshot): boolean {
	return snapshot.overageInUse === true || (snapshot.isUsingOverage === true && snapshot.rateLimitType !== "seven_day_overage_included");
}

/** A completed turn the CLI reported as charged to usage credits. Its message is fixed provider text. */
export class SdkUsageCreditsCharged extends SdkProviderError {
	constructor(readonly rateLimit: RateLimitSnapshot) {
		super("Claude SDK billing: Anthropic charged this turn to usage credits (extra usage) instead of the plan limits");
	}
}

/** Anthropic's refusal to serve a request on plan limits; matched on the sanitized API error detail. */
const USAGE_CREDITS_REJECTION = /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/i;
export function usageCreditsRejected(detail: string | undefined): boolean {
	return detail !== undefined && USAGE_CREDITS_REJECTION.test(detail);
}

/**
 * The user-facing error for a billing stop. It names billing, so Pi's retry
 * classifier treats it as non-retryable; the side-effect caveat stays because a
 * billing stop is still a post-start failure.
 */
export const USAGE_CREDITS_CHARGED_MESSAGE = "Claude SDK billing: Anthropic charged this turn to usage credits (extra usage) instead of the plan limits. " +
	"The turn was stopped so no further turns are charged; turn off extra usage for this Claude account to stay on plan limits. " +
	"Reconcile any pending side effects before retrying";
export const USAGE_CREDITS_REJECTED_MESSAGE = "Claude SDK billing: Anthropic refused this request on the plan limits and wants to charge it to usage credits " +
	"(plan limit used up, or the request was classified as third-party app usage); it was not retried. " +
	"Reconcile any pending side effects before retrying";
