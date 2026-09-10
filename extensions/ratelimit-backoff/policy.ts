/**
 * When to resume a session whose last turn died on a provider rate limit.
 *
 * Pure, so the schedule is tested without timers or a provider. index.ts owns
 * the clock and the follow-up message.
 *
 * ## The measured shape
 *
 * pi retries a retryable provider error INSIDE the turn (settings.retry:
 * `baseDelayMs * 2 ** attempt`, 3 attempts from a 2 s base by default — 14 s
 * in total) and then the turn FAILS. Nothing re-issues it: the session sits
 * idle, the workspace shows a stack of `Turn failed · 0s · 429: {"code":"1302",
 * "message":"Rate limit reached for requests"}` lines, and a human or the
 * orchestrator has to notice and steer. Measured 2026-09-11 on the TES-9799
 * worker: 20 rate-limit refusals in one session, four consecutive failed
 * turns a second apart in the screenshot that opened this work.
 *
 * ## The rule
 *
 * A rate limit is the ONE provider error that waiting fixes, so the answer is
 * to wait — longer each time, bounded, and out loud. Delay doubles per
 * consecutive rate-limited turn from RATE_LIMIT_BASE_MS, capped at
 * RATE_LIMIT_CAP_MS, jittered so a fleet of sessions throttled together does
 * not resume together; a `Retry-After` the provider names wins. After
 * MAX_CONTINUATIONS the extension stops and says so — a session that has been
 * throttled for half an hour is a capacity decision for the operator, not
 * something to keep poking.
 *
 * What it is NOT: an exhausted allowance (402/403, "insufficient credits",
 * "quota exceeded") is not cleared by waiting — that is credential-recovery's
 * job, and this extension defers to `isQuotaExhaustedText` so the two never
 * both fire on one error.
 */

import { isAuthFailureText, isQuotaExhaustedText } from "../credential-recovery/quota.ts";

export const RATE_LIMIT_BASE_MS = 30_000;
export const RATE_LIMIT_CAP_MS = 5 * 60_000;
export const MAX_CONTINUATIONS = 8;
/** ±25 %: a fleet throttled at once must not resume at once. */
export const JITTER = 0.25;

/**
 * A rate limit, anchored the way quota.ts anchors its patterns: on the status
 * code or the two-word phrase, never on a bare "limit", which every quota,
 * budget and context message also contains. Same expression subagent/model.ts
 * uses to decide whether another account would help.
 */
export const RATE_LIMITED = /\b429\b|\brate.?limit/i;

/** True for a throttle another attempt will clear; false for exhaustion, auth, or anything else. */
export function isRateLimitedText(text: unknown): boolean {
	if (typeof text !== "string" || text === "") return false;
	if (isAuthFailureText(text) || isQuotaExhaustedText(text)) return false;
	return RATE_LIMITED.test(text);
}

/**
 * The wait a provider named, in ms, when the error text carries one.
 * `retry-after: 30`, `Retry-After: 30s`, `retry after 2 minutes`, `try again
 * in 45 seconds` — the spellings seen across OpenAI, OpenRouter and z.ai.
 * Bounded by the cap: a provider asking for an hour gets the cap, and the
 * next failure escalates from there.
 */
export function retryAfterMs(text: string): number | undefined {
	const m = /retry[- ]after\s*:?\s*(\d+)\s*(ms|s|sec|seconds?|m|min|minutes?)?\b/i.exec(text) ?? /try again in\s*(\d+)\s*(ms|s|sec|seconds?|m|min|minutes?)?\b/i.exec(text);
	if (!m) return undefined;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	const unit = (m[2] ?? "s").toLowerCase();
	const ms = unit === "ms" ? n : unit.startsWith("m") ? n * 60_000 : n * 1000;
	return Math.min(ms, RATE_LIMIT_CAP_MS);
}

export interface BackoffDecision {
	/** How long to wait before continuing. */
	delayMs: number;
	/** 1-based count of consecutive rate-limited turns, this one included. */
	attempt: number;
	/** Where the delay came from, for the status line. */
	source: "retry-after" | "backoff";
}

/**
 * The next wait, or null when the budget is spent.
 *
 * `streak` is the number of consecutive rate-limited turns BEFORE this one;
 * `random` is injectable for the jitter.
 */
export function nextBackoff(streak: number, errorText: string, random: () => number = Math.random): BackoffDecision | null {
	const attempt = streak + 1;
	if (attempt > MAX_CONTINUATIONS) return null;
	const named = retryAfterMs(errorText);
	if (named !== undefined) return { delayMs: named, attempt, source: "retry-after" };
	const base = Math.min(RATE_LIMIT_CAP_MS, RATE_LIMIT_BASE_MS * 2 ** (attempt - 1));
	const jitter = 1 + (random() * 2 - 1) * JITTER;
	return { delayMs: Math.round(base * jitter), attempt, source: "backoff" };
}

/** The status-bar line while waiting. */
export function waitingStatus(d: BackoffDecision): string {
	const secs = Math.max(1, Math.round(d.delayMs / 1000));
	const when = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`;
	return `rate limited — continuing in ${when} (${d.attempt}/${MAX_CONTINUATIONS}${d.source === "retry-after" ? ", provider's retry-after" : ""})`;
}

/** The status-bar line when the budget is spent. */
export function gaveUpStatus(streak: number): string {
	return `rate limited ${streak} turns in a row — automatic continuation stopped; wait for capacity or switch model, then steer to continue`;
}

/** The follow-up that resumes the task. */
export const CONTINUE_MESSAGE =
	"The provider rate limit has had time to clear. Continue the interrupted task from the current transcript and completed tool results; do not repeat completed actions.";
