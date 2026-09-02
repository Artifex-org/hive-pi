/**
 * "Is this session out of allowance, or is something else wrong?" — the
 * predicate mid-session quota failover is built on (HIV-3249).
 *
 * Every provider string below is one this fleet actually emitted; the dates are
 * in the source's pattern comments. The tests that matter most are the negative
 * ones: a false positive migrates a healthy session off a working provider,
 * which is a failure this module would have invented rather than found.
 */

import { describe, expect, it } from "vitest";
import {
	isAuthFailureText,
	isQuotaExhausted,
	isQuotaExhaustedText,
	newestTurnFailure,
	quotaRunLength,
} from "../extensions/hive-common/quota.ts";

/** Codex at 100% of its 7-day quota (2026-09-02, HIV-3235). */
const CODEX_QUOTA = "Codex error: The usage limit has been reached";
/** xAI with no credits on the credential (2026-08-26). */
const XAI_CREDITS =
	'403 "You have run out of credits or need a Grok subscription to continue."';
/** The OpenRouter 402 that froze five pyERP agents (2026-08-15). */
const OPENROUTER_402 =
	'402 This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 72902. "limit_source":"openrouter_key_limit"';

const toolResult = () => ({ message: { role: "toolResult", content: "ok" } });
const teamMessage = () => ({ type: "custom", customType: "team-message", data: null });
const drained = (text = CODEX_QUOTA) => ({ message: { role: "assistant", stopReason: "error", errorMessage: text } });
const ran = (stopReason = "stop") => ({ message: { role: "assistant", stopReason, content: "done" } });

describe("isQuotaExhaustedText", () => {
	it("matches each provider's exhaustion wording", () => {
		expect(isQuotaExhaustedText(CODEX_QUOTA)).toBe(true);
		expect(isQuotaExhaustedText(XAI_CREDITS)).toBe(true);
		expect(isQuotaExhaustedText(OPENROUTER_402)).toBe(true);
		expect(isQuotaExhaustedText("You've hit your usage limit. Try again at May 30th, 2026 8:12 PM")).toBe(true);
		expect(isQuotaExhaustedText("insufficient_quota: You exceeded your current quota")).toBe(true);
	});

	// These recover by waiting. Failing over on one would abandon a funded
	// account because a request happened to land during a blip.
	it("does not match a transient failure", () => {
		for (const text of [
			"429 Too Many Requests: rate limit exceeded, retry after 20s",
			"Codex error: Our servers are currently overloaded. Please try again later.",
			"WebSocket idle timeout after 300000ms",
			"fetch failed",
			"503 Service Unavailable",
			"This operation was aborted",
		]) {
			expect(isQuotaExhaustedText(text), text).toBe(false);
		}
	});

	// The remedy is `pi auth`, not another provider — switching would abandon a
	// perfectly funded account whose token merely needed refreshing.
	it("does not match an auth failure", () => {
		for (const text of [
			"401 Unauthorized",
			"refresh token is invalid or expired",
			"invalid_api_key: the supplied key is not valid",
			"Your session has expired, please re-authenticate",
		]) {
			expect(isQuotaExhaustedText(text), text).toBe(false);
			expect(isAuthFailureText(text), text).toBe(true);
		}
	});

	// THE VETO, exercised. The cases above are decided by the quota patterns
	// simply not matching, so they pass with or without the auth check — a
	// negative control confirmed they do. Only a string matching BOTH sets
	// tests precedence, and these are real: a provider that cannot verify a
	// credential often says so in the vocabulary of allowance.
	it("calls a message matching both classes an auth failure, not exhaustion", () => {
		for (const text of [
			"401: your subscription could not be verified — you have run out of credits or need a Grok subscription",
			"invalid_api_key: usage limit has been reached for an unauthenticated key",
			"refresh token expired; insufficient_quota",
		]) {
			expect(isAuthFailureText(text), text).toBe(true);
			// Fails over on this and a funded account is abandoned because its
			// token needed refreshing.
			expect(isQuotaExhaustedText(text), text).toBe(false);
			expect(newestTurnFailure([drained(text)]), text).toBe("auth_expired");
		}
	});

	// A tool result quoted back inside an error must not trip a bare word. This
	// is why no pattern is just "credits" or "limit".
	it("does not match prose that merely mentions credits or limits", () => {
		for (const text of [
			"tool error: could not open the credits page",
			"the limit column is null for this row",
			"AssertionError: expected quota to be 100",
		]) {
			expect(isQuotaExhaustedText(text), text).toBe(false);
		}
	});

	it("is false for a non-string and for nothing at all", () => {
		expect(isQuotaExhaustedText(undefined)).toBe(false);
		expect(isQuotaExhaustedText("")).toBe(false);
		expect(isQuotaExhaustedText({ message: CODEX_QUOTA })).toBe(false);
	});
});

describe("quotaRunLength", () => {
	it("is zero when the newest assistant turn reached the provider", () => {
		expect(quotaRunLength([drained(), ran()])).toBe(0);
		expect(quotaRunLength([ran()])).toBe(0);
		expect(quotaRunLength([])).toBe(0);
	});

	// An injection lands BETWEEN two assistant turns. The provider saw an
	// unbroken run of refusals regardless of what this harness put in between.
	it("counts through the injections that separate the refusals", () => {
		expect(quotaRunLength([drained(), teamMessage(), drained(), toolResult(), drained()])).toBe(3);
	});

	it("stops at the first assistant turn that is not an exhaustion", () => {
		// A rate limit in the middle breaks the run: it recovers by waiting, so
		// the newer refusals are not evidence of a drained account on their own.
		expect(quotaRunLength([drained(), drained("429 rate limit exceeded"), drained()])).toBe(1);
	});

	// Both are unbroken runs of failed turns and they need opposite remedies:
	// compaction fixes an overflow, and nothing the session does to its own
	// context restores an allowance.
	it("does not fire on a context overflow", () => {
		const overflow = drained('400 "This model\'s maximum prompt length is 500000 but the request contains 505280 tokens."');
		expect(quotaRunLength([overflow, overflow])).toBe(0);
	});

	it("treats one refusal as enough, because pi already retried it", () => {
		expect(isQuotaExhausted([ran(), drained()])).toBe(true);
		expect(isQuotaExhausted([drained(), ran()])).toBe(false);
	});
});

describe("newestTurnFailure", () => {
	it("separates the three classes whose remedies differ", () => {
		expect(newestTurnFailure([drained(CODEX_QUOTA)])).toBe("quota_exhausted");
		expect(newestTurnFailure([drained("401 Unauthorized")])).toBe("auth_expired");
		expect(newestTurnFailure([drained("503 Service Unavailable")])).toBe("other");
	});

	// "Failed for a reason we do not recognise" must stay distinguishable from
	// "did not fail": reporting the former as healthy is how this whole class of
	// provider failure stayed invisible (HIV-1926).
	it("is null only when the newest assistant turn did not fail", () => {
		expect(newestTurnFailure([drained(), ran()])).toBeNull();
		expect(newestTurnFailure([])).toBeNull();
		expect(newestTurnFailure([drained("something nobody has seen before")])).toBe("other");
	});

	it("reads the newest assistant turn, not the newest entry", () => {
		expect(newestTurnFailure([drained(CODEX_QUOTA), toolResult(), teamMessage()])).toBe("quota_exhausted");
	});
});
