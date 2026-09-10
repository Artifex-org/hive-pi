/**
 * A turn that died on a provider rate limit is resumed after an escalating
 * wait, out loud, a bounded number of times — and never when something else
 * already took the next turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ratelimitBackoff, { RATELIMIT_CHANNEL } from "../extensions/ratelimit-backoff/index.ts";
import {
	isRateLimitedText,
	JITTER,
	MAX_CONTINUATIONS,
	nextBackoff,
	RATE_LIMIT_BASE_MS,
	RATE_LIMIT_CAP_MS,
	retryAfterMs,
	waitingStatus,
} from "../extensions/ratelimit-backoff/policy.ts";
import { isSocketUnreachable } from "../extensions/credential-recovery/index.ts";
import { createFakePi } from "./fake-pi.ts";

const GLM = '429: {"code":"1302","message":"Rate limit reached for requests"}';

describe("isRateLimitedText — what waiting fixes", () => {
	it("matches the measured refusal and not exhaustion, auth, or other errors", () => {
		expect(isRateLimitedText(GLM)).toBe(true);
		expect(isRateLimitedText("Rate limit exceeded, retry-after: 20")).toBe(true);
		expect(isRateLimitedText('403 "You have run out of credits or need a Grok subscription"')).toBe(false);
		expect(isRateLimitedText("401 invalid api key")).toBe(false);
		expect(isRateLimitedText("Subagent became inactive for 600s and was stopped.")).toBe(false);
		expect(isRateLimitedText("context window limit reached")).toBe(false);
		expect(isRateLimitedText(undefined)).toBe(false);
	});
});

describe("nextBackoff — the ladder", () => {
	const mid = () => 0.5; // no jitter
	it("doubles from the base, caps, and stops after the budget", () => {
		expect(nextBackoff(0, GLM, mid)).toEqual({ delayMs: RATE_LIMIT_BASE_MS, attempt: 1, source: "backoff" });
		expect(nextBackoff(1, GLM, mid)?.delayMs).toBe(RATE_LIMIT_BASE_MS * 2);
		expect(nextBackoff(3, GLM, mid)?.delayMs).toBe(RATE_LIMIT_BASE_MS * 8);
		expect(nextBackoff(6, GLM, mid)?.delayMs).toBe(RATE_LIMIT_CAP_MS);
		expect(nextBackoff(MAX_CONTINUATIONS - 1, GLM, mid)?.attempt).toBe(MAX_CONTINUATIONS);
		expect(nextBackoff(MAX_CONTINUATIONS, GLM, mid)).toBeNull();
	});
	it("jitters within ±25% so a throttled fleet does not resume in lockstep", () => {
		expect(nextBackoff(0, GLM, () => 0)?.delayMs).toBe(Math.round(RATE_LIMIT_BASE_MS * (1 - JITTER)));
		expect(nextBackoff(0, GLM, () => 1)?.delayMs).toBe(Math.round(RATE_LIMIT_BASE_MS * (1 + JITTER)));
	});
	it("honours a Retry-After the provider names, bounded by the cap", () => {
		expect(retryAfterMs("429 Too Many Requests. Retry-After: 45")).toBe(45_000);
		expect(retryAfterMs("rate limit; try again in 2 minutes")).toBe(120_000);
		expect(retryAfterMs("retry-after: 3600s")).toBe(RATE_LIMIT_CAP_MS);
		expect(retryAfterMs(GLM)).toBeUndefined();
		expect(nextBackoff(0, "429 retry-after: 12", mid)).toEqual({ delayMs: 12_000, attempt: 1, source: "retry-after" });
	});
	it("renders a status a person can read", () => {
		expect(waitingStatus({ delayMs: 30_000, attempt: 1, source: "backoff" })).toBe(`rate limited — continuing in 30s (1/${MAX_CONTINUATIONS})`);
		expect(waitingStatus({ delayMs: 240_000, attempt: 4, source: "retry-after" })).toContain("4 min");
		expect(waitingStatus({ delayMs: 240_000, attempt: 4, source: "retry-after" })).toContain("provider's retry-after");
	});
});

describe("the extension", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const failed = (error: string) => ({ type: "agent_end", messages: [{ role: "user", content: "go" }, { role: "assistant", content: "", stopReason: "error", errorMessage: error }] });
	const ok = { type: "agent_end", messages: [{ role: "user", content: "go" }, { role: "assistant", content: "done", stopReason: "stop" }] };

	it("waits, then sends one continue follow-up, and clears its status", async () => {
		const pi = createFakePi();
		ratelimitBackoff(pi.api);
		await pi.emit({ type: "session_start" });
		await pi.emit(failed(GLM), { idle: true, pendingMessages: false });
		expect(pi.statuses.at(-1)?.text).toContain("continuing in");
		expect(pi.messages).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(RATE_LIMIT_BASE_MS * (1 + JITTER) + 1);
		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].customType).toBe("ratelimit-backoff");
		expect(pi.messages[0].content).toContain("do not repeat completed actions");
		expect(pi.statuses.at(-1)?.text).toBeUndefined();
		expect(pi.busEvents.filter((e) => e.name === RATELIMIT_CHANNEL).map((e) => (e.payload as { state: string }).state)).toEqual(["waiting", "continuing"]);
	});

	it("escalates across consecutive failures and resets on a turn that reached the provider", async () => {
		const pi = createFakePi();
		ratelimitBackoff(pi.api);
		await pi.emit({ type: "session_start" });
		await pi.emit(failed(GLM), { idle: true });
		const first = (pi.busEvents.at(-1)?.payload as { delayMs: number }).delayMs;
		await vi.advanceTimersByTimeAsync(RATE_LIMIT_CAP_MS);
		await pi.emit(failed(GLM), { idle: true });
		const second = (pi.busEvents.filter((e) => e.name === RATELIMIT_CHANNEL).at(-1)?.payload as { delayMs: number; attempt: number });
		expect(second.attempt).toBe(2);
		expect(second.delayMs).toBeGreaterThan(first * 1.2);
		await vi.advanceTimersByTimeAsync(RATE_LIMIT_CAP_MS);
		await pi.emit(ok, { idle: true });
		await pi.emit(failed(GLM), { idle: true });
		expect((pi.busEvents.filter((e) => e.name === RATELIMIT_CHANNEL).at(-1)?.payload as { attempt: number }).attempt).toBe(1);
	});

	it("does not fire into a session someone else already continued", async () => {
		const pi = createFakePi();
		ratelimitBackoff(pi.api);
		await pi.emit({ type: "session_start" });
		await pi.emit(failed(GLM), { idle: true });
		await pi.emit({ type: "input", source: "user", text: "carry on" });
		await vi.advanceTimersByTimeAsync(RATE_LIMIT_CAP_MS);
		expect(pi.messages).toHaveLength(0);
	});

	it("does not fire when the session is busy at the deadline", async () => {
		const pi = createFakePi();
		ratelimitBackoff(pi.api);
		await pi.emit({ type: "session_start" });
		await pi.emit(failed(GLM), { idle: false, pendingMessages: true });
		await vi.advanceTimersByTimeAsync(RATE_LIMIT_CAP_MS);
		expect(pi.messages).toHaveLength(0);
	});

	it("leaves exhaustion and auth failures to credential-recovery", async () => {
		const pi = createFakePi();
		ratelimitBackoff(pi.api);
		await pi.emit({ type: "session_start" });
		await pi.emit(failed("402 insufficient credits"), { idle: true });
		await pi.emit(failed("401 invalid api key"), { idle: true });
		await vi.advanceTimersByTimeAsync(RATE_LIMIT_CAP_MS);
		expect(pi.messages).toHaveLength(0);
		expect(pi.busEvents.filter((e) => e.name === RATELIMIT_CHANNEL)).toHaveLength(0);
	});

	it("gives up loudly after the budget", async () => {
		const pi = createFakePi();
		ratelimitBackoff(pi.api);
		await pi.emit({ type: "session_start" });
		for (let i = 0; i < MAX_CONTINUATIONS; i++) {
			await pi.emit(failed(GLM), { idle: true });
			await vi.advanceTimersByTimeAsync(RATE_LIMIT_CAP_MS * 2);
		}
		expect(pi.messages).toHaveLength(MAX_CONTINUATIONS);
		await pi.emit(failed(GLM), { idle: true });
		await vi.advanceTimersByTimeAsync(RATE_LIMIT_CAP_MS * 2);
		expect(pi.messages).toHaveLength(MAX_CONTINUATIONS);
		expect(pi.statuses.at(-1)?.text).toContain("automatic continuation stopped");
		expect((pi.busEvents.at(-1)?.payload as { state: string }).state).toBe("gave-up");
	});
});

describe("credential-recovery — a socket the sandbox will never let us reach", () => {
	it("recognises the connect errors that do not recover by retrying", () => {
		expect(isSocketUnreachable("connect EPERM /tmp/hive-launch-pi-76227317/auth.json.hive-recovery.sock")).toBe(true);
		expect(isSocketUnreachable("connect ENOENT /tmp/x.sock")).toBe(true);
		expect(isSocketUnreachable("Credential exchange timed out")).toBe(false);
		expect(isSocketUnreachable("Credential exchange failed (HTTP 500)")).toBe(false);
	});
});
