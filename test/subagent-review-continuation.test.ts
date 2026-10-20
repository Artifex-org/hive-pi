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
function fixture(symlink = false) {
	const cwd = fs.mkdtempSync(join(tmpdir(), "review-continuation-test-")); roots.push(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
	fs.writeFileSync(join(cwd, "change.ts"), "export const value = 1;\n"); git("add", "."); git("commit", "-m", "base");
	git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
	fs.writeFileSync(join(cwd, "change.ts"), "export const value = 2;\n"); git("add", "change.ts");
	const diff = captureDeliveryDiff(cwd)!;
	const artifactDir = fs.mkdtempSync(join(tmpdir(), "review-artifact-test-")); roots.push(artifactDir);
	const artifact = join(artifactDir, "patch.md"); fs.writeFileSync(artifact, diff.text);
	const reads = new ReviewArtifactReads(artifact, diff.text, cwd);
	const alias = join(artifactDir, "checkout");
	if (symlink) fs.symlinkSync(cwd, alias);
	const c = new ReviewContinuation(symlink ? alias : cwd, "review", reviewFingerprint(diff), reads); roots.push(c.dir);
	const cover = (offset = 1, limit = diff.text.split("\n").length) => {
		const text = diff.text.split("\n").slice(offset - 1, offset - 1 + limit).join("\n");
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
const incomplete = "DELIVERY_REVIEW_INCOMPLETE: more";
describe("ReviewContinuation", () => {
	it("accepts a persisted physical checkout when invoked through its symlink", () => {
		const { c, cover, persist } = fixture(true); cover(1, 1); persist(incomplete);
		expect(c.next(incomplete, true).prompt).toContain("Unread artifact line ranges");
	});
	it("requires observed progress and caps progressing continuations at four", () => {
		const { c, cover, persist } = fixture(); persist(incomplete);
		expect(c.next(incomplete, true)).toEqual({});
		for (let round = 1; round <= 4; round++) {
			cover(round, 1); expect(c.next(incomplete, true).prompt).toContain("Unread artifact line ranges");
			expect(c.next(incomplete, true)).toEqual({});
		}
		cover(5, 1); expect(c.next(incomplete, true)).toEqual({});
	});
	it("permits only one conclusion continuation after complete reads", () => {
		const { c, cover, persist } = fixture(); cover(); persist(incomplete);
		expect(c.next(incomplete, true).prompt).toContain("Every artifact line has been read");
		expect(c.next(incomplete, true)).toEqual({});
	});
	it.each(["missing", "wrong-id", "wrong-cwd", "missing-finding", "broken-json"])("refuses an invalid persisted transcript (%s)", kind => {
		const { c, cover, persist } = fixture(); cover(1, 1);
		const file = persist(kind === "missing-finding" ? "different report" : incomplete);
		if (kind === "missing") fs.rmSync(file);
		else if (kind === "broken-json") fs.writeFileSync(file, "invalid");
		else if (kind !== "missing-finding") {
			const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(row => JSON.parse(row));
			rows[0][kind === "wrong-id" ? "id" : "cwd"] = kind === "wrong-id" ? "not-the-id" : "/wrong/cwd";
			fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
		}
		expect(c.next(incomplete, true).error).toContain("matching persisted reviewer transcript");
	});
	it("never retries failed workers even with progress and a persisted transcript", () => {
		const { c, cover, persist } = fixture(); cover(1, 1); persist(incomplete);
		expect(c.next(incomplete, false)).toEqual({});
	});
	it("rejects changed evidence even after a complete successful review", () => {
		const { c, cover, cwd } = fixture(); cover();
		fs.writeFileSync(join(cwd, "change.ts"), "export const value = 3;\n");
		expect(c.next("Complete review.", true).error).toContain("evidence changed");
	});
	it("configures private identity and removes all session material on cleanup", () => {
		const { c, persist } = fixture(); const args = ["--mode", "json", "--no-session"]; c.configure(args);
		expect(args).toEqual(["--mode", "json", "--session-dir", c.dir, "--session-id", c.id]);
		expect(fs.statSync(c.dir).mode & 0o777).toBe(0o700); persist(incomplete);
		c.cleanup(); expect(fs.existsSync(c.dir)).toBe(false);
	});
	it("does not reuse pending read IDs from an earlier worker process", () => {
		const { reads, artifact } = fixture();
		reads.observe({ type: "tool_execution_start", toolName: "read", toolCallId: "stale", args: { path: artifact, offset: 1 } });
		reads.beginRound();
		reads.observe({ type: "tool_execution_end", toolName: "read", toolCallId: "stale", result: { content: [{ type: "text", text: fs.readFileSync(artifact, "utf8") }] } });
		expect(reads.coveredLines()).toBe(0);
	});
});
