import { describe, expect, it } from "vitest";
import { ReviewLedger } from "../extensions/subagent/review-ledger.ts";
const frame = (findings: unknown[]) => `REVIEW_LEDGER ${JSON.stringify({ complete: true, findings })}`;
const claim = { id: null, status: "new", location: "Dockerfile:7", issue: "race", scenario: "A and B both observe absence.", evidence: "The read precedes the write." };
const disposition = { id: "F1", status: "upheld", location: "Dockerfile:7", evidence: "Caller permits the A/B interleaving." };
describe("ReviewLedger explicit protocol", () => {
	it("assigns independent IDs at the same location and keeps original support immutable", () => {
		const ledger = new ReviewLedger(); expect(ledger.apply(frame([claim, { ...claim, issue: "data loss" }])).complete).toBe(true);
		expect(JSON.parse(ledger.retained()).map((r: { id: string }) => r.id)).toEqual(["F1", "F2"]);
		expect(ledger.apply(frame([{ ...disposition, issue: "replacement", scenario: "replacement" }])).complete).toBe(false);
		const first = JSON.parse(ledger.retained())[0]; expect(first.issue).toBe("race"); expect(first.scenario).toBe(claim.scenario); expect(first.evidence).toBe(claim.evidence);
	});
	it.each(["", "REVIEW_LEDGER invalid", "REVIEW_LEDGER null", "REVIEW_LEDGER []", "REVIEW_LEDGER {}", 'REVIEW_LEDGER {"findings":[]}', 'REVIEW_LEDGER {"complete":"true","findings":[]}', "REVIEW_LEDGER {\"findings\":null}", frame([null]), frame([{}]), frame([{ ...claim, scenario: "" }]), frame([{ ...claim, evidence: "" }]), frame([{ ...claim, location: "file:0" }]), frame([{ ...claim, id: "F9", status: "resolved" }]), frame([{ ...claim, status: {} }])])("cannot accept a malformed or incomplete frame %s", output => {
		const ledger = new ReviewLedger(); expect(ledger.apply(output).complete).toBe(false); expect(ledger.retained()).toBe("[]");
	});
	it.each([
		`> ${frame([])}`, `    ${frame([])}`, `\t${frame([])}`, `\`\`\`json\n${frame([])}\n\`\`\``,
		`\`\`\`\`text\n\`\`\`\n${frame([])}\n\`\`\`\``, `~~~text\n${frame([])}\n~~~`, `${frame([])}\n${frame([])}`,
		`\`\`\`text\n\`\`\`json\n${frame([])}\n\`\`\``, `~~~text\n~~~json\n${frame([])}\n~~~`,
		`\`\`\`text\n\`\`\`\u00a0\n${frame([])}\n\`\`\``,
	])("does not accept a quoted/example or duplicate protocol frame %s", output => {
		expect(new ReviewLedger().apply(output).complete).toBe(false);
	});
	it("validates the whole frame before mutating state, including duplicate and unknown IDs", () => {
		const ledger = new ReviewLedger(); ledger.apply(frame([claim])); const original = ledger.retained();
		for (const records of [[disposition, disposition], [disposition, { ...disposition, id: "F9" }], [{ ...claim, issue: "new claim" }, { ...disposition, evidence: "" }]]) {
			expect(ledger.apply(frame(records)).complete).toBe(false); expect(ledger.retained()).toBe(original);
		}
	});
	it("requires every previous finding, but retains valid new evidence from a noncumulative report", () => {
		const ledger = new ReviewLedger(); ledger.apply(frame([claim]));
		expect(ledger.apply(frame([{ ...claim, issue: "second", scenario: "UNIQUE SECOND" }])).feedback).toContain("F1");
		expect(ledger.retained()).toContain(claim.scenario); expect(ledger.retained()).toContain("UNIQUE SECOND");
		expect(ledger.apply(frame([disposition, { ...disposition, id: "F2", status: "withdrawn" }])).complete).toBe(true);
	});
	it("requires an explicit semantic completion declaration, not just reconciled records", () => {
		const ledger = new ReviewLedger();
		expect(ledger.apply('REVIEW_LEDGER {"complete":false,"findings":[]}').complete).toBe(false);
		expect(ledger.apply(frame([])).complete).toBe(true);
	});
	it("rejects over-budget support without truncating or partially applying it", () => {
		const ledger = new ReviewLedger(); const result = ledger.apply(frame([{ ...claim, scenario: "x".repeat(65536) }]));
		expect(result.error).toContain("64KiB"); expect(ledger.retained()).toBe("[]");
	});
});
