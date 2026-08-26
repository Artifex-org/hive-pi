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
