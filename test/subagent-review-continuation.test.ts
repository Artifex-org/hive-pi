import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ReviewArtifactReads } from "../extensions/subagent/review-artifact.ts";
import { ReviewContinuation } from "../extensions/subagent/review-continuation.ts";
import { captureDeliveryDiff, reviewFingerprint } from "../extensions/subagent/reviewdiff.ts";

it("loads the continuation module in native strip-only Node, as the MCP server does", () => {
	expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", "await import(\"./extensions/subagent/review-continuation.ts\")"], { cwd: process.cwd(), stdio: "pipe" })).not.toThrow();
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(symlink = false, artifactText?: string) {
	const cwd = fs.mkdtempSync(join(tmpdir(), "review-continuation-test-")); roots.push(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
	fs.writeFileSync(join(cwd, "change.ts"), "export const value = 1;\n"); git("add", "."); git("commit", "-m", "base");
	git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
	fs.writeFileSync(join(cwd, "change.ts"), "export const value = 2;\n"); git("add", "change.ts");
	const diff = captureDeliveryDiff(cwd)!;
	const artifactDir = fs.mkdtempSync(join(tmpdir(), "review-artifact-test-")); roots.push(artifactDir);
	const artifact = join(artifactDir, "patch.md");
	const text = artifactText ?? diff.text; const lines = text.split("\n"); fs.writeFileSync(artifact, text);
	const reads = new ReviewArtifactReads(artifact, text, cwd);
	const alias = join(artifactDir, "checkout"); if (symlink) fs.symlinkSync(cwd, alias);
	const c = new ReviewContinuation(symlink ? alias : cwd, "review", reviewFingerprint(diff), reads); roots.push(c.dir);
	const cover = (offset = 1, limit = lines.length) => {
		const text = lines.slice(offset - 1, offset - 1 + limit).join("\n");
		reads.observe({ type: "tool_execution_start", toolName: "read", toolCallId: "read", args: { path: artifact, offset, limit } });
		reads.observe({ type: "tool_execution_end", toolName: "read", toolCallId: "read", isError: false, result: { content: [{ type: "text", text }] } });
	};
	const persist = (output: string) => {
		const file = SessionManager.findById(cwd, c.id, c.dir);
		const manager = file ? SessionManager.open(file, c.dir) : SessionManager.create(cwd, c.dir, { id: c.id });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: output }], api: "openai-responses", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
		return manager.getSessionFile()!;
	};
	return { cwd, artifact, reads, c, cover, persist };
}
const frame = (findings: unknown[] = []) => `REVIEW_LEDGER ${JSON.stringify({ complete: true, findings })}`;
const fresh = (location: string, issue: string, scenario = "Two callers interleave before publication.") => ({ id: null, status: "new", location, issue, scenario, evidence: "The read occurs before the create-if-absent boundary." });
const disposition = (id: string, location = "code.ts:7", status = "upheld") => ({ id, status, location, evidence: "Caller permits the failing input; the read precedes publication." });
const advance = (c: ReviewContinuation, output: string, success: boolean, finished = true) =>
 c.next([{ role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" }], success, finished);
const incomplete = `DELIVERY_REVIEW_INCOMPLETE: more\n${frame()}`;
describe("ReviewContinuation", () => {
	it.each(["progress", "mixed-final", "tool-stop", "duplicate-final"])("rejects nonauthoritative invocation frames: %s", kind => {
		const { c, cover } = fixture(); cover();
		const final = { role: "assistant", content: [{ type: "text", text: frame() }], stopReason: "stop" };
		const messages = kind === "progress" ? [{ ...final, content: [{ type: "text", text: frame([fresh("code.ts:7", "lost finding")]) }] }, final] :
			kind === "mixed-final" ? [{ ...final, content: [...final.content, { type: "toolCall", text: "" }] }] :
			kind === "tool-stop" ? [{ ...final, stopReason: "toolUse" }] :
			[{ ...final, content: [{ type: "text", text: frame() + "\n" + frame() }] }];
		expect(c.next(messages, true).error).toContain("invalid ledger protocol");
	});
	it("accepts a persisted physical checkout when invoked through its symlink", () => {
		const { c, cover, persist } = fixture(true); cover(1, 1); persist(incomplete);
		expect(advance(c, incomplete, true).prompt).toContain("Coverage work for this invocation");
	});
	it("requires observed progress and caps small progressing continuations at four", () => {
		const { c, cover, persist } = fixture(); persist(incomplete);
		expect(advance(c, incomplete, true).error).toContain("no newly observed");
		for (let round = 1; round <= 4; round++) {
			cover(round, 1); expect(advance(c, incomplete, true).prompt).toContain("Coverage work for this invocation");
			expect(advance(c, incomplete, true).error).toContain(round === 4 ? "budget exhausted" : "no newly observed");
		}
		cover(5, 1); expect(advance(c, incomplete, true).error).toContain("budget exhausted");
	});
	it("permits only one conclusion continuation after complete reads", () => {
		const { c, cover, persist } = fixture(); cover(); persist(incomplete);
		expect(advance(c, incomplete, true).prompt).toContain("Every artifact line has been read");
		expect(advance(c, incomplete, true).error).toContain("semantic conclusion still incomplete");
	});
	it("sizes the bounded budget to pages and preserves five rounds of independent findings", () => {
		const { c, reads, cover, persist } = fixture(false, ("x".repeat(1000) + "\n").repeat(15000));
		expect(c.maxRounds).toBeGreaterThan(4); expect(c.initialPrompt()).toContain("read offset=1 limit=40");
		for (let round = 0; round < 5; round++) {
			for (const page of reads.pages.slice(round * 8, (round + 1) * 8)) cover(page.offset, page.limit);
			const report = `DELIVERY_REVIEW_INCOMPLETE: more\n${frame([
				...Array.from({ length: round }, (_, i) => disposition(`F${i + 1}`, `code.ts:${i + 1}`)), fresh(`code.ts:${round + 1}`, `finding ${round}`),
			])}`;
			persist(report); const next = advance(c, report, true); expect(next.error).toBeUndefined();
			for (let prior = 0; prior <= round; prior++) expect(next.prompt).toContain(`finding ${prior}`);
		}
		for (const page of reads.pages.slice(40)) cover(page.offset, page.limit);
		expect(reads.complete()).toBe(true);
		expect(advance(c, frame(Array.from({ length: 5 }, (_, i) => disposition(`F${i + 1}`, `code.ts:${i + 1}`))), true).findings).toContain("finding 0");
	});
	it("retains original support without duplicating fourteen large cumulative human reports", () => {
		const { c, reads, cover, persist } = fixture(false, ("x".repeat(1000) + "\n").repeat(15000));
		for (let round = 0; round < 14; round++) {
			cover(reads.pages[round].offset, reads.pages[round].limit);
			const report = `DELIVERY_REVIEW_INCOMPLETE: more\n${"large human recap ".repeat(1500)}\npass ${round}\n${frame([
				round ? disposition("F1") : fresh("code.ts:7", "race", "original support ".repeat(1500)),
			])}`;
			persist(report); const next = advance(c, report, true);
			expect(next.error).toBeUndefined(); expect(next.prompt).toContain("original support");
			expect(Buffer.byteLength(next.prompt!)).toBeLessThan(64 * 1024 + 4096);
		}
	});
	it("requires evidence-bearing dispositions for prior IDs before completion", () => {
		const { c, cover, persist } = fixture(); cover(1, 1); const report = frame([fresh("code.ts:7", "concrete bug")]);
		persist(report); expect(advance(c, report, true).prompt).toContain("code.ts:7"); cover(); persist(frame());
		expect(advance(c, frame(), true).prompt).toContain("F1"); expect(advance(c, frame(), true).error).toContain("F1");
		expect(advance(c, frame([disposition("F1", "code.ts:7", "withdrawn")]), true).findings).toContain("concrete bug");
	});
	it.each(["Dockerfile", "src/[id]/page.tsx", "source (copy)/file name"])("retains a finding at valid Git path %s", path => {
		const { c, cover, persist } = fixture(); cover(1, 1); const report = frame([fresh(`${path}:7`, "concrete bug")]); persist(report);
		expect(advance(c, report, true).prompt).toContain("F1"); cover(); persist(frame());
		expect(advance(c, frame(), true).prompt).toContain(path); expect(advance(c, frame(), true).error).toContain("F1");
	});
	it("does not collapse independent findings at the same location", () => {
		const { c, cover, persist } = fixture(); cover(1, 1); const report = frame([fresh("code.ts:7", "race"), fresh("code.ts:7", "data loss")]); persist(report);
		const next = advance(c, report, true); expect(next.prompt).toContain("F1"); expect(next.prompt).toContain("F2");
		cover(); const partial = frame([disposition("F2", "code.ts:7", "resolved")]); persist(partial);
		expect(advance(c, partial, true).prompt).toContain("F1"); expect(advance(c, partial, true).error).toContain("F1");
	});
	it.each(["```text\nDELIVERY_REVIEW_INCOMPLETE: callers remain\n```", "    DELIVERY_REVIEW_INCOMPLETE: callers remain"])("keeps refusal-only reports incomplete despite required protocol metadata: %s", refusal => {
		const { c, cover, persist } = fixture(); cover(); const output = `${refusal}\n${frame()}`; persist(output);
		expect(advance(c, output, true).prompt).toContain("Every artifact line");
		expect(advance(c, output, true).error).toContain("semantic conclusion still incomplete");
	});
	it("does not invent phantom IDs from rephrased required human recaps", () => {
		const { c, cover, persist } = fixture(); cover(); const first = `DELIVERY_REVIEW_INCOMPLETE: integrate\ncode.ts:7 — race\n${frame([fresh("code.ts:7", "race")])}`;
		persist(first); expect(advance(c, first, true).prompt).toContain("F1");
		const final = `code.ts:7 — concurrent publication remains unsafe\n${frame([disposition("F1")])}`;
		const result = advance(c, final, true); expect(result.error).toBeUndefined();
		expect(JSON.parse(result.findings!)).toHaveLength(1);
	});
	it.each([
		"Review complete.\n[F1] see previous report.",
		`\`\`\`text\n${frame([disposition("F1")])}\n\`\`\``,
		`> ${frame([disposition("F1")])}`,
		`    ${frame([disposition("F1")])}`,
	])("does not reconcile using a bare ID or quoted protocol example: %s", output => {
		const { c, cover, persist } = fixture(); cover(1, 1); const first = frame([fresh("code.ts:7", "race")]); persist(first); advance(c, first, true);
		cover(); persist(output); expect(advance(c, output, true).error).toContain("invalid ledger protocol");
	});
	it("keeps immutable original reproduction support after a noncumulative F2-only report", () => {
		const { c, cover, persist } = fixture(); cover(1, 1); const first = frame([fresh("code.ts:7", "race", "UNIQUE-ORIGINAL-INTERLEAVING")]);
		persist(first); advance(c, first, true); cover(2, 1); const second = frame([fresh("code.ts:9", "partial group", "UNIQUE-SECOND-SCENARIO")]);
		persist(second); const next = advance(c, second, true);
		expect(next.prompt).toContain("UNIQUE-ORIGINAL-INTERLEAVING"); expect(next.prompt).toContain("UNIQUE-SECOND-SCENARIO");
	});
	it("fails explicitly rather than truncating oversized original finding support", () => {
		const { c, cover, persist } = fixture(); cover(1, 1); const report = frame([fresh("code.ts:7", "race", "x".repeat(70 * 1024))]); persist(report);
		expect(advance(c, report, true).error).toContain("64KiB");
	});
	it.each(["missing", "wrong-id", "wrong-cwd", "missing-finding", "broken-json"])("refuses an invalid persisted transcript (%s)", kind => {
		const { c, cover, persist } = fixture(); cover(1, 1); const file = persist(kind === "missing-finding" ? "different report" : incomplete);
		if (kind === "missing") fs.rmSync(file);
		else if (kind === "broken-json") fs.writeFileSync(file, "invalid");
		else if (kind !== "missing-finding") {
			const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(row => JSON.parse(row));
			rows[0][kind === "wrong-id" ? "id" : "cwd"] = kind === "wrong-id" ? "not-the-id" : "/wrong/cwd";
			fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
		}
		expect(advance(c, incomplete, true).error).toContain("matching persisted reviewer transcript");
	});
	it("never retries a failed worker", () => {
		const { c, cover, persist } = fixture(); cover(1, 1); persist(incomplete); expect(advance(c, incomplete, false)).toEqual({});
	});
	it("rejects changed evidence even after a complete successful review", () => {
		const { c, cover, cwd } = fixture(); cover(); fs.writeFileSync(join(cwd, "change.ts"), "export const value = 3;\n");
		expect(advance(c, frame(), true).error).toContain("evidence changed");
	});
	it("configures private identity and removes all session material on cleanup", () => {
		const { c, persist } = fixture(); const args = ["--mode", "json", "--no-session"]; c.configure(args);
		expect(args).toEqual(["--mode", "json", "--session-dir", c.dir, "--session-id", c.id]);
		expect(fs.statSync(c.dir).mode & 0o777).toBe(0o700); persist(incomplete); c.cleanup(); expect(fs.existsSync(c.dir)).toBe(false);
	});
	it("does not reuse pending read IDs from an earlier worker process", () => {
		const { reads, artifact } = fixture();
		reads.observe({ type: "tool_execution_start", toolName: "read", toolCallId: "stale", args: { path: artifact, offset: 1 } }); reads.beginRound();
		reads.observe({ type: "tool_execution_end", toolName: "read", toolCallId: "stale", result: { content: [{ type: "text", text: fs.readFileSync(artifact, "utf8") }] } });
		expect(reads.coveredLines()).toBe(0);
	});
});
