import { describe, expect, it } from "vitest";
import { failedToolEvidence, redactEvidence, stableFindingID } from "../extensions/you-should-know/evidence.ts";

describe("you-should-know evidence", () => {
	it("redacts well-known and caller-provided secrets", () => {
		const out = redactEvidence("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 AKIA1234567890ABCDEF Bearer abc.def token=secret", ["private"]);
		expect(out).not.toMatch(/ghp_|AKIA|Bearer abc|token=secret/);
		expect(redactEvidence("private", ["private"])).toContain("[REDACTED]");
	});
	it("redacts environment assignments and quoted JSON credentials before truncation", () => {
		for (const input of ['HIVE_TOKEN=opaque-value', 'AWS_SECRET_ACCESS_KEY=opaque-value', 'api_key: opaque-value', '{"access_token":"opaque-value"}', "{'password': 'opaque-value'}"]) {
			expect(redactEvidence(input), input).not.toContain("opaque-value");
			expect(redactEvidence(input), input).toContain("[REDACTED]");
		}
		for (const input of ['PASSWORD="two word secret"', '{"password":"two word secret"}', String.raw`{"password":"two \"word\" secret"}`, "TOKEN='two word secret'"]) {
			const out = redactEvidence(input + "\ncontext survives");
			expect(out, input).not.toMatch(/two|word|secret/);
			expect(out, input).toContain("context survives");
		}
		const result = failedToolEvidence({ isError: true, toolCallId: "cred", toolName: "bash", content: [{ type: "text", text: "HIVE_TOKEN=" + "x".repeat(4000) + "\nFailure after credential" }] });
		expect(result?.text).toContain("Failure after credential");
		expect(result?.text).not.toContain("x".repeat(20));
	});
	it("only extracts explicit textual tool failures", () => {
		expect(failedToolEvidence({ isError: false, toolCallId: "x", toolName: "read", content: [{ type: "text", text: "miss" }] })).toBeUndefined();
		const out = failedToolEvidence({ isError: true, toolCallId: "id", toolName: "lookup", input: "secret args", details: { secret: "no" }, content: [{ type: "text", text: "failed\u001b[31m\nlookup" }, { type: "image", data: "hidden" }] });
		expect(out?.text).toBe("failed\nlookup");
		expect(out?.context).toBe("lookup");
		expect(failedToolEvidence({ isError: true, toolCallId: "x", toolName: "papercut", content: [{ type: "text", text: "ack" }] })).toBeUndefined();
	});
	it("produces a stable opaque finding hash", () => {
		expect(stableFindingID("s", "i", "q")).toBe(stableFindingID("s", "i", "q"));
		expect(stableFindingID("s", "i", "q")).toHaveLength(64);
	});
});
