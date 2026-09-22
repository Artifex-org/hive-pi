import { describe, expect, it } from "vitest";
import { buildStatus } from "../extensions/hive-remote/status.ts";

// HIV-3452. The status post is how the server's quota sweep decides what a
// quota-drained session needs. account_recovery=true tells it "this client will
// swap accounts itself, wait"; that is false for a client that CANNOT reach its
// recovery socket, and a sandboxed session reporting it parked forever.
const CODEX_QUOTA = "Codex error: The usage limit has been reached";
function ctxWithDrainedTurn() {
	const branch = [{ message: { role: "assistant", stopReason: "error", errorMessage: CODEX_QUOTA } }];
	return {
		getContextUsage: () => undefined,
		model: { provider: "openai-codex", id: "gpt-6-sol", contextWindow: 272000 },
		thinkingLevel: "high",
		sessionManager: { getBranch: () => branch },
	} as never;
}
const pi = { getThinkingLevel: () => "high" } as never;

describe("buildStatus account recovery", () => {
	it("keeps a drained session waiting while its client can still recover", () => {
		const status = buildStatus(ctxWithDrainedTurn(), pi, {}, undefined, "exhausted");
		expect(status.account_recovery).toBe(true);
		expect(status.provider_failure).toBe("quota_exhausted");
	});

	it("hands an unavailable-recovery session to failover as quota_exhausted", () => {
		const status = buildStatus(ctxWithDrainedTurn(), pi, {}, undefined, "unavailable");
		expect(status.account_recovery).toBeUndefined();
		expect(status.provider_failure).toBe("quota_exhausted");
	});

	it("still reports an unexplained recovery error as other", () => {
		const status = buildStatus(ctxWithDrainedTurn(), pi, {}, undefined, "error");
		expect(status.provider_failure).toBe("other");
	});
});
