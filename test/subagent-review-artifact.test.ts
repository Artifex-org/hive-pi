import { describe, expect, it } from "vitest";
import { ReviewArtifactReads, reviewArtifactText } from "../extensions/subagent/review-artifact.ts";

const patch = "a\nb\nc\n";
function page(reads: ReviewArtifactReads, offset: number, limit: number, text: string, extra: Record<string, unknown> = {}) {
	const toolCallId = `read-${offset}`;
	reads.observe({ type: "tool_execution_start", toolName: "read", toolCallId, args: { path: "/tmp/patch", offset, limit } });
	reads.observe({ type: "tool_execution_end", toolName: "read", toolCallId, result: { content: [{ type: "text", text }] }, ...extra });
}
describe("artifact read coverage", () => {
	it("keeps ordinary patches raw and losslessly chunks long escaped/Unicode lines", () => {
		expect(reviewArtifactText(patch)).toEqual({ text: patch, chunked: false });
		const raw = '🧪\0"\\'.repeat(20000);
		const encoded = reviewArtifactText(raw);
		expect(encoded.chunked).toBe(true); expect(JSON.parse(encoded.text).join("")).toBe(raw);
		expect(encoded.text.split("\n").every(line => Buffer.byteLength(line) < 32 * 1024)).toBe(true);
	});
	it("plans contiguous pages under both native read caps and preserves every byte", () => {
		for (const text of [("🧪".repeat(100) + "\n").repeat(800), "\n".repeat(5000)]) {
			const lines = text.split("\n"), reads = new ReviewArtifactReads("/tmp/patch", text, "/repo");
			const returned: string[] = [];
			let cursor = 1;
			for (const plan of reads.pages) {
				expect(plan.offset).toBe(cursor); expect(plan.limit).toBeLessThanOrEqual(1000);
				const output = lines.slice(plan.offset - 1, plan.offset - 1 + plan.limit).join("\n");
				expect(Buffer.byteLength(output)).toBeLessThanOrEqual(40 * 1024);
				returned.push(output); page(reads, plan.offset, plan.limit, output); cursor += plan.limit;
			}
			expect(returned.join("\n")).toBe(text); expect(reads.complete()).toBe(true); expect(reads.pagePlan()).toBe("");
		}
	});
	it("refuses a raw line that cannot fit a read page", () => {
		expect(() => new ReviewArtifactReads("/tmp/patch", "x".repeat(50 * 1024), "/repo")).toThrow("unpageable line");
	});
	it("accepts exact pages out of order with overlap and pagination notices", () => {
		const reads = new ReviewArtifactReads("/tmp/patch", patch, "/repo");
		page(reads, 3, 2, "c\n"); page(reads, 1, 2, "a\nb\n\n[2 more lines in file. Use offset=3 to continue.]");
		expect(reads.complete()).toBe(true);
	});
	it("does not count lines omitted by the read tool's truncation", () => {
		const reads = new ReviewArtifactReads("/tmp/patch", patch, "/repo");
		page(reads, 1, 4, "a", { result: { content: [{ type: "text", text: "a\n\n[Showing lines 1-1 of 4. Use offset=2 to continue.]" }], details: { truncation: { outputLines: 1 } } } });
		page(reads, 3, 2, "c\n"); expect(reads.complete()).toBe(false);
		page(reads, 2, 1, "b"); expect(reads.complete()).toBe(true);
	});
	it.each([
		{ isError: true },
		{ result: { content: [{ type: "text", text: "different artifact" }] } },
		{ result: { content: [{ type: "text", text: patch }], details: { truncation: { outputLines: 4, firstLineExceedsLimit: true } } } },
		{ result: { content: [{ type: "text", text: "a" }], details: { truncation: { outputLines: 4 } } } },
	])("does not credit failed, altered, or incomplete returned evidence: %j", extra => {
		const reads = new ReviewArtifactReads("/tmp/patch", patch, "/repo");
		page(reads, 1, 4, patch, extra); expect(reads.complete()).toBe(false);
	});
	it("ignores reads of other paths and unmatched results", () => {
		const reads = new ReviewArtifactReads("/tmp/patch", patch, "/repo");
		reads.observe({ type: "tool_execution_start", toolName: "read", toolCallId: "r", args: { path: "/tmp/other" } });
		reads.observe({ type: "tool_execution_end", toolName: "read", toolCallId: "r", result: { content: [{ type: "text", text: patch }] } });
		expect(reads.complete()).toBe(false);
	});
});
