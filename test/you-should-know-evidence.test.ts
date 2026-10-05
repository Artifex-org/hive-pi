import { describe, expect, it } from "vitest";
import { failedToolEvidence, redactEvidence, stableFindingID } from "../extensions/you-should-know/evidence.ts";

describe("you-should-know evidence", () => {
	it("redacts well-known and caller-provided secrets", () => {
		const out = redactEvidence("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 AKIA1234567890ABCDEF Bearer abc.def token=secret", ["private"]);
		expect(out).not.toMatch(/ghp_|AKIA|Bearer abc|token=secret/);
		expect(redactEvidence("private", ["private"])).toContain("[REDACTED]");
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
