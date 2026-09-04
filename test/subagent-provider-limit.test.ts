/**
 * The two provider refusals a delegation caller cannot tell apart.
 *
 * Both arrived as `Agent error: <raw provider string>` with a distilled note
 * whose class is `worker-error` — the same class a crashed worker gets. pi
 * treats them as OPPOSITES: it classifies a 429 as retryable and burns its whole
 * budget with exponential backoff before that string exists, and classifies a
 * 403 "out of credits" as non-retryable, so that one failed on the first
 * attempt. The caller was given the same words for both and, having no other
 * signal, re-issued into a drained account.
 *
 * The strings below are the real ones from the papercut corpus, not paraphrases.
 */

import { describe, expect, it } from "vitest";

import { providerLimitGuidance, retryNote, type SingleResult } from "../extensions/subagent/index.ts";

const OUT_OF_CREDITS = '403 "You have run out of credits or need a Grok subscription"';
const RATE_LIMITED = '429 {"code":"1302","message":"Rate limit reached for requests"}';

describe("which refusal this is, and whether retrying is worth anything", () => {
	it("tells a drained account apart from a throttled one", () => {
		const exhausted = providerLimitGuidance(OUT_OF_CREDITS, "xai/grok-4", undefined);
		expect(exhausted).toContain("allowance exhausted");
		expect(exhausted).toContain("Waiting will not help");

		const throttled = providerLimitGuidance(RATE_LIMITED, "xai/grok-4", {
			attempts: 3,
			maxAttempts: 3,
			waitedMs: 14_000,
			succeeded: false,
		});
		expect(throttled).toContain("throttled");
		// The opposite instruction — and never the exhaustion one.
		expect(throttled).toContain("Waiting ~60s");
		expect(throttled).not.toContain("will not help");
	});

	it("names WHICH account refused, because it is not the one the caller can see", () => {
		// The worker runs on `subagentDefaultModel`, a different account from this
		// session's model and from the balance `readiness` reports — which is why
		// "$7.11 left but 403" kept reading as a bug.
		expect(providerLimitGuidance(OUT_OF_CREDITS, "xai/grok-4", undefined)).toContain("`xai/grok-4`");
		// A 403 can land before any assistant message carried a model.
		expect(providerLimitGuidance(OUT_OF_CREDITS, undefined, undefined)).toContain("the worker's default model");
	});

	it("spends pi's real retry accounting rather than inventing a count", () => {
		expect(
			providerLimitGuidance(RATE_LIMITED, "m", { attempts: 3, maxAttempts: 3, waitedMs: 14_000, succeeded: false }),
		).toContain("retried 3/3 times over ~14s");
		// Absent accounting is stated as absent. A confident "3/3" here would be a
		// number the harness never observed.
		const unaccounted = providerLimitGuidance(RATE_LIMITED, "m", undefined);
		expect(unaccounted).toContain("No retry accounting");
		expect(unaccounted).not.toContain("3/3");
	});

	it("refuses to call an unaccounted 429 a throttle, because it may be exhaustion", () => {
		// THE EXPENSIVE MISTAKE THIS GUARDS. Reaching here means the text said
		// 429 and QUOTA_PATTERNS did not match — but that set is deliberately
		// narrow, and providers do ship exhaustion under a 429. Treating "no
		// quota pattern matched" as proof of a throttle tells someone whose
		// account is drained to wait, which is the one instruction that costs
		// them the whole budget again.
		const ambiguous = providerLimitGuidance(RATE_LIMITED, "m", undefined) ?? "";
		expect(ambiguous).toContain("CANNOT be classified");
		expect(ambiguous).toContain("exhausted allowance");
		// It must NOT issue the confident throttle remedy on this evidence.
		expect(ambiguous).not.toContain("Waiting ~60s");
		// With accounting that ran out, pi DID judge it retryable and spent
		// backoff — that is earned evidence, so the confident remedy returns.
		const spent =
			providerLimitGuidance(RATE_LIMITED, "m", {
				attempts: 3,
				maxAttempts: 3,
				waitedMs: 14_000,
				succeeded: false,
			}) ?? "";
		expect(spent).toContain("Waiting ~60s");
		expect(spent).not.toContain("CANNOT be classified");
	});

	it("does not blame a retry that LANDED for a later failure", () => {
		// The fold's `errorMessage` is latest-wins and never cleared, so a 429 that
		// pi recovered from can still be in hand when a later turn dies. Citing
		// that sequence would report a wait as the cause of the wrong failure.
		//
		// The note must say what is TRUE: accounting WAS observed and it
		// succeeded. Claiming "no retry accounting" here — as this test used to
		// assert — describes the opposite of the input it is given.
		const recovered = providerLimitGuidance(RATE_LIMITED, "m", {
			attempts: 1,
			maxAttempts: 3,
			waitedMs: 2000,
			succeeded: true,
		});
		expect(recovered).toContain("SUCCEEDED");
		expect(recovered).toContain("stale");
		expect(recovered).not.toContain("no retry accounting");
	});

	it("stays silent on everything that is not a provider limit", () => {
		// The failure mode to avoid is an over-match telling an agent "retrying
		// will not help" when it would have. A miss only restores today's note.
		expect(providerLimitGuidance("Segmentation fault (core dumped)", "m", undefined)).toBeUndefined();
		expect(providerLimitGuidance("2 tests failed", "m", undefined)).toBeUndefined();
		// Bare words that a narrower anchor must not catch.
		expect(providerLimitGuidance("the credits page explains billing", "m", undefined)).toBeUndefined();
		expect(providerLimitGuidance("context limit exceeded for this request", "m", undefined)).toBeUndefined();
		expect(providerLimitGuidance("could not generate limited output", "m", undefined)).toBeUndefined();
		expect(providerLimitGuidance(undefined, "m", undefined)).toBeUndefined();
	});
});

describe("the note the caller actually reads", () => {
	const failed = (errorMessage: string): SingleResult => ({
		agent: "code-reviewer",
		agentSource: "package",
		task: "review the diff",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: "xai/grok-4",
		stopReason: "error",
		errorMessage,
	});

	it("carries the guidance into the retry note, not just into a helper", () => {
		// The gap this closes is the one that produced this papercut:
		// `isQuotaExhaustedText` was correct, tested, and had no production caller
		// at all. A classifier nobody calls is one that does not exist.
		const note = retryNote(failed(OUT_OF_CREDITS));
		expect(note).toContain("provider limit:");
		expect(note).toContain("`xai/grok-4`");
		// The distilled note itself is unchanged and still leads.
		expect(note).toContain("attempted: review the diff");
	});

	it("leaves an ordinary failure's note exactly as it was", () => {
		expect(retryNote(failed("Segmentation fault (core dumped)"))).not.toContain("provider limit:");
	});
});
