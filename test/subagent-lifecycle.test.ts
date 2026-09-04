import { describe, expect, it } from "vitest";
import {
	describeLifecycleEvent,
	silenceError,
	shouldStopForSilence,
	WORKER_ACTIVITY_SILENCE_MS,
	WORKER_STARTUP_SILENCE_MS,
} from "../extensions/subagent/lifecycle.ts";

describe("subagent lifecycle reporting", () => {
	it("maps Pi JSON lifecycle events to operator-visible activity", () => {
		expect(describeLifecycleEvent({ type: "session" })).toBe("worker session started");
		expect(describeLifecycleEvent({ type: "agent_start" })).toBe("agent started");
		expect(describeLifecycleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta" } })).toBe("writing response");
		expect(describeLifecycleEvent({ type: "tool_execution_start", toolName: "grep" })).toBe("running grep");
		expect(describeLifecycleEvent({ type: "tool_execution_end", toolName: "grep" })).toBe("finished grep");
		expect(describeLifecycleEvent({ type: "unknown" })).toBeUndefined();
	});

	it("names pi's own retry backoff, which otherwise reads as a frozen worker", () => {
		// pi retries a 429 itself with exponential backoff (2s/4s/8s) and emits
		// nothing else meanwhile. Unmapped, those 14 seconds looked like a hang.
		expect(describeLifecycleEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000 })).toBe(
			"retrying (2/3) in 4000ms",
		);
		expect(describeLifecycleEvent({ type: "auto_retry_end", success: false })).toBe("retries exhausted");
		expect(describeLifecycleEvent({ type: "auto_retry_end", success: true })).toBe("retry succeeded");
	});

	it("distinguishes a failed startup from an inactive worker", () => {
		expect(silenceError(false, 120_000)).toContain("did not start within 120s");
		expect(silenceError(true, 600_000)).toContain("became inactive for 600s");
	});

	it("only stops workers at their respective silence boundary", () => {
		const now = 1_000_000;
		expect(shouldStopForSilence(false, now - WORKER_STARTUP_SILENCE_MS + 1, now)).toBe(false);
		expect(shouldStopForSilence(false, now - WORKER_STARTUP_SILENCE_MS, now)).toBe(true);
		expect(shouldStopForSilence(true, now - WORKER_ACTIVITY_SILENCE_MS + 1, now)).toBe(false);
		expect(shouldStopForSilence(true, now - WORKER_ACTIVITY_SILENCE_MS, now)).toBe(true);
	});
});
