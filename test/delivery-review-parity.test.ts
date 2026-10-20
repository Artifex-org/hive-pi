/**
 * Delivery-guard shapes measured in the HIV-3906 eval: what Claude Code runs
 * without friction must pass here too, while the genuinely unreviewable
 * shapes keep their refusal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryTargets, readOnlyFilter, registerDeliveryReview, reviewFingerprint, scanDeliveryTargets, treeFingerprint } from "../extensions/subagent/delivery.ts";
import { captureDeliveryDiff, type ReviewDiff } from "../extensions/subagent/reviewdiff.ts";
import { BACKGROUND_JOB_CHANNEL } from "../extensions/background/channel.ts";
import { backgroundStartedMessage } from "../extensions/subagent/background.ts";
import { createFakePi } from "./fake-pi.ts";

const repos: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repo(hooks: string[] = []) {
	const cwd = mkdtempSync(join(tmpdir(), "delivery-parity-")); repos.push(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
	git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
	writeFileSync(join(cwd, "code.ts"), "export const n = 0;\n");
	git("add", "."); git("commit", "-m", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
	for (const name of hooks) { const hook = join(cwd, ".git", "hooks", name); writeFileSync(hook, "#!/bin/sh\nexit 0\n"); chmodSync(hook, 0o755); }
	return { cwd, git };
}
const substantive = Array.from({ length: 12 }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n";
type Verdict = { block: boolean; reason: string } | undefined;

async function reviewed(pi: ReturnType<typeof createFakePi>, cwd: string) {
	await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "review", input: { agent: "code-reviewer", cwd } });
	await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "review", input: {}, isError: false,
		details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(captureDeliveryDiff(cwd)!) }] } });
}
const deliver = async (pi: ReturnType<typeof createFakePi>, command: string, cwd: string, toolCallId = "deliver") =>
	(await pi.emit({ type: "tool_call", toolName: "bash", toolCallId, input: { command, cwd } }))[0] as Verdict;

describe("delivery guard: shapes from the eval", () => {
	it.each([
		"git push --no-verify -u origin HEAD 2>&1",
		"git push -u origin HEAD 2>&1 | tail -5",
		"git push origin HEAD >/dev/null 2>&1",
		"git push origin HEAD &>/dev/null",
	])("passes a reviewed push with fd-duplication redirects: %s", async (command) => {
		const { cwd, git } = repo(["pre-push"]); writeFileSync(join(cwd, "code.ts"), substantive); git("commit", "-qam", "code");
		const pi = createFakePi(); registerDeliveryReview(pi.api); await reviewed(pi, cwd);
		expect(await deliver(pi, command, cwd)).toBeUndefined();
	});

	it("passes `cd X && git push` when the hooked push is the last delivery", async () => {
		const { cwd, git } = repo(["pre-push"]); writeFileSync(join(cwd, "code.ts"), substantive); git("commit", "-qam", "code");
		const pi = createFakePi(); registerDeliveryReview(pi.api); await reviewed(pi, cwd);
		expect(await deliver(pi, `cd ${cwd} && git push --no-verify -u origin HEAD`, tmpdir())).toBeUndefined();
	});

	it.each(["git commit --no-verify -m m && git push --no-verify", "git commit -m m && git push origin HEAD"])(
		"passes a hooked commit followed only by its push, with or without --no-verify: %s", async (command) => {
			const { cwd, git } = repo(["pre-commit", "pre-push"]); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
			const pi = createFakePi(); registerDeliveryReview(pi.api); await reviewed(pi, cwd);
			expect(await deliver(pi, command, cwd)).toBeUndefined();
		});

	it.each([
		["git commit -m m && gh pr create --title t --body b", "gh pr create --title t --body b", "pre-commit"],
		["git commit --no-verify -m m && git push --no-verify && gh pr create --title t --body b", "gh pr create --title t --body b", "pre-commit"],
		["git push origin HEAD && gh pr create --title t --body b", "gh pr create --title t --body b", "pre-push"],
	])("refuses a hooked leg followed by a later delivery leg: %s", async (command, later, hook) => {
		const { cwd, git } = repo(["pre-commit", "pre-push"]); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api); await reviewed(pi, cwd);
		const verdict = await deliver(pi, command, cwd);
		expect(verdict).toMatchObject({ block: true });
		expect(verdict!.reason).toContain(`executable hooks (${hook})`);
		expect(verdict!.reason).toContain(`later delivery leg \`${later}\``);
	});

	it("keeps refusing writes to files and process substitution", () => {
		for (const command of ["git push origin HEAD > push.log", "git push origin HEAD 2>>err.txt", "gh pr create --body-file <(git log)", "git push origin HEAD <<< yes"]) {
			expect(scanDeliveryTargets(command, "/repo")[0], command).toMatchObject({ target: null, cause: expect.stringContaining("redirects to or from a file") });
		}
	});

	it("allows only read-only filters after a delivery in a pipeline", () => {
		for (const filter of ["tail -5", "head -n 20", "grep -v hint", "sed -n 1,5p", "sed -n '/error/p'", "wc -l", "cat"]) expect(readOnlyFilter(filter), filter).toBe(true);
		for (const filter of ["tee push.log", "sed -i s/a/b/ code.ts", "sed -n 'w out'", "sort -o out", "sort -uo out", "xargs rm", "tail -5 > out.txt"]) expect(readOnlyFilter(filter), filter).toBe(false);
		expect(deliveryTargets("git push origin HEAD 2>&1 | tail -5", "/repo")).toEqual(["/repo"]);
		for (const command of ["git push origin HEAD | tee push.log", "git status | git push", "cd /elsewhere | cat\ngit push", "git push origin HEAD &", "git push origin HEAD | tail -5 &"]) {
			expect(deliveryTargets(command, "/repo"), command).toEqual([null]);
		}
	});

	it("reads POSIX quote escapes and quoted here-documents as literal", () => {
		expect(deliveryTargets("gh pr create --draft --body 'a '\\''b'\\'' c'", "/repo")).toEqual(["/repo"]);
		expect(deliveryTargets("gh pr create --title \"say \\\"hi\\\"\" --body x", "/repo")).toEqual(["/repo"]);
		const heredoc = "gh pr create --title t --body-file - <<'EOF'\nIt's literal: $(git reset --hard) and `ticks`\ngit push other HEAD\nEOF";
		expect(deliveryTargets(heredoc, "/repo")).toEqual(["/repo"]);
		expect(deliveryTargets(`cd /repo && ${heredoc}\ngit push origin HEAD`, "/tmp")).toEqual(["/repo", "/repo"]);
	});

	it("refuses genuinely dynamic arguments and names what could not be read", () => {
		const cases: [string, string][] = [
			['gh pr create --body "$(git log -1)"', "command substitution `$(…)`"],
			['gh pr create --body "$(cat x; git reset --hard)"', "command substitution `$(…)`"],
			["gh pr create --title t --body \"`date`\"", "backtick command substitution"],
			["gh pr create --title $TITLE", "variable `$TITLE`"],
			["gh pr create --title t --body-file - <<EOF\n$(git reset --hard)\nEOF", "command substitution `$(…)`"],
		];
		for (const [command, cause] of cases) {
			const [scan] = scanDeliveryTargets(command, "/repo");
			expect(scan, command).toMatchObject({ target: null });
			expect(scan.cause, command).toContain("its arguments are dynamic");
			expect(scan.cause, command).toContain(cause);
		}
		// The read-only body-file substitution stays supported, as before.
		expect(deliveryTargets('gh pr create --title t --body "$(cat x)"', "/repo")).toEqual(["/repo"]);
	});
});

describe("delivery review: tree fingerprint, background and unavailable reviewers", () => {
	it("does not let a dirty revert pass off an unreviewed commit", async () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api); await reviewed(pi, cwd);
		writeFileSync(join(cwd, "code.ts"), substantive + "export const unreviewed = 1;\n"); git("commit", "-qam", "more");
		writeFileSync(join(cwd, "code.ts"), substantive); // the working tree now matches the review, HEAD does not
		expect(treeFingerprint(cwd, "worktree")).not.toBe(treeFingerprint(cwd, "head"));
		expect(await deliver(pi, "git push origin HEAD", cwd)).toMatchObject({ block: true });
	});

	it("matches a committed tree to the reviewed working tree, and nothing else", () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive);
		const reviewedTree = treeFingerprint(cwd, "worktree");
		git("commit", "-qam", "code");
		expect(treeFingerprint(cwd, "head")).toBe(reviewedTree);
		writeFileSync(join(cwd, "code.ts"), substantive + "x\n"); git("commit", "-qam", "edit");
		expect(treeFingerprint(cwd, "head")).not.toBe(reviewedTree);
	});

	// What the subagent tool does for `background: true`: emit the job start,
	// then return the receipt naming the job id.
	const start = async (pi: ReturnType<typeof createFakePi>, id: string, task: string, toolCallId = "bg") => {
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "start", id, sessionId: "s", executionId: "e", what: "review", kind: "subagent", detail: `code-reviewer: ${task}` });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId, input: {}, isError: false, content: [{ type: "text", text: backgroundStartedMessage(id, "review", "code-reviewer") }], details: { results: [] } });
	};
	const finish = (pi: ReturnType<typeof createFakePi>, id: string, status: "done" | "failed", chunk = "Looks good.") => {
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "output", id, sessionId: "s", executionId: "e", chunk });
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "finish", id, sessionId: "s", executionId: "e", status, exitCode: status === "done" ? 0 : 1 });
	};

	it("accepts a background code-reviewer that completed cleanly on the same diff", async () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "bg", input: { agent: "code-reviewer", background: true, what: "review", task: "Review", cwd } });
		await start(pi, "sub-1", "Review");
		expect(await deliver(pi, "git push origin HEAD", cwd)).toMatchObject({ block: true, reason: expect.stringContaining("still running") });
		finish(pi, "sub-1", "done");
		expect(await deliver(pi, "git commit -m code && git push origin HEAD", cwd)).toBeUndefined();
		expect(pi.entries.at(-1)).toMatchObject({ customType: "delivery-review", data: { source: "background" } });
	});

	it.each([
		["a failed run", "failed", "Agent error"],
		["a run that stopped mid-work", "done", "I'll check the remaining files next.\n\n⚠ the worker ended WITHOUT delivering: its last message announces work rather than reporting it. Treat this as incomplete — check the tree for partial edits before building on it."],
	] as const)("does not accept %s", async (_name, status, chunk) => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "bg", input: { agent: "code-reviewer", background: true, what: "review", task: "Review", cwd } });
		await start(pi, "sub-1", "Review"); finish(pi, "sub-1", status, chunk);
		expect(await deliver(pi, "git push origin HEAD", cwd)).toMatchObject({ block: true, reason: expect.stringContaining("finished without a complete review") });
	});

	it("does not accept a background review when the diff changed after dispatch", async () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "bg", input: { agent: "code-reviewer", background: true, what: "review", task: "Review", cwd } });
		await start(pi, "sub-1", "Review");
		writeFileSync(join(cwd, "code.ts"), substantive + "export const late = 1;\n"); git("add", ".");
		finish(pi, "sub-1", "done");
		expect(await deliver(pi, "git push origin HEAD", cwd)).toMatchObject({ block: true, reason: expect.stringContaining("diff changed after it was dispatched") });
	});

	it("attaches a job to the call that started it, even with identical tasks or an early finish", async () => {
		const a = repo(), b = repo();
		for (const { cwd, git } of [a, b]) { writeFileSync(join(cwd, "code.ts"), substantive); git("add", "."); }
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		// A's call is refused before any job starts; B's job finishes before its receipt is read.
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "bg-a", input: { agent: "code-reviewer", background: true, what: "review", task: "Review the change", cwd: a.cwd } });
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "bg-b", input: { agent: "code-reviewer", background: true, what: "review", task: "Review the change", cwd: b.cwd } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "bg-a", input: {}, isError: true, content: [{ type: "text", text: "Background delegation needs `what`" }] });
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "start", id: "sub-1", sessionId: "s", executionId: "e", what: "review", kind: "subagent", detail: "code-reviewer: Review the change" });
		finish(pi, "sub-1", "done");
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "bg-b", input: {}, isError: false, content: [{ type: "text", text: backgroundStartedMessage("sub-1", "review", "code-reviewer") }] });
		expect(await deliver(pi, "git commit -m code && git push origin HEAD", b.cwd)).toBeUndefined();
		expect(await deliver(pi, "git commit -m code && git push origin HEAD", a.cwd)).toMatchObject({ block: true, reason: expect.stringContaining("No code review has run") });
	});

	it("flags a chained commit whose hook changed the reviewed code before the push", async () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const hook = join(cwd, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nprintf 'export const formatted = 1;\\n' >> code.ts\ngit add code.ts\n"); chmodSync(hook, 0o755);
		const pi = createFakePi(); registerDeliveryReview(pi.api); await reviewed(pi, cwd);
		expect(await deliver(pi, "git commit -m code && git push origin HEAD", cwd, "chain")).toBeUndefined();
		git("commit", "-m", "code"); // what the chain ran; the hook appended a line
		const [result] = await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "chain", input: {}, isError: false, content: [{ type: "text", text: "pushed" }] });
		expect(JSON.stringify(result)).toContain("changed the code after its review");
	});

	it("stays quiet after a chained commit that delivered exactly the reviewed tree", async () => {
		const { cwd, git } = repo(["pre-commit"]); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api); await reviewed(pi, cwd);
		expect(await deliver(pi, "git commit -m code && git push origin HEAD", cwd, "chain")).toBeUndefined();
		git("commit", "-m", "code");
		const [result] = await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "chain", input: {}, isError: false, content: [{ type: "text", text: "pushed" }] });
		expect(result).toBeUndefined();
	});

	const unavailable = { agent: "code-reviewer", exitCode: 1, messages: [], stderr: 'the delegation default openai-codex/gpt-5 is not configured on this machine (no credential for provider "openai-codex"), and nothing else is configured to fall back to; no worker was started.' };

	it("records 'review unavailable' when no reviewer model can run, and says so on delivery", async () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", task: "Review", cwd } });
		const [noted] = await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: true, content: [{ type: "text", text: "Agent failed" }], details: { results: [unavailable] } });
		expect(JSON.stringify(noted)).toContain("Review unavailable");
		expect(pi.entries.at(-1)).toMatchObject({ customType: "delivery-review", data: { source: "unavailable", unavailable: expect.stringContaining("nothing else is configured") } });
		expect(await deliver(pi, "git push origin HEAD", cwd, "push")).toBeUndefined();
		const [result] = await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "push", input: {}, isError: false, content: [{ type: "text", text: "pushed" }] });
		expect(JSON.stringify(result)).toContain("ran WITHOUT a code review");
		// A failed push is not reported as delivered.
		expect(await deliver(pi, "git push origin HEAD", cwd, "failed-push")).toBeUndefined();
		const [failed] = await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "failed-push", input: {}, isError: true, content: [{ type: "text", text: "rejected" }] });
		expect(failed).toBeUndefined();
		// A real review of the same diff supersedes the "unavailable" record.
		await reviewed(pi, cwd);
		expect(await deliver(pi, "git push origin HEAD", cwd, "push2")).toBeUndefined();
		const [clean] = await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "push2", input: {}, isError: false, content: [{ type: "text", text: "pushed" }] });
		expect(clean).toBeUndefined();
		// The record is for this diff only: an edit needs another attempt.
		writeFileSync(join(cwd, "code.ts"), substantive + "export const later = 1;\n"); git("add", ".");
		expect(await deliver(pi, "git push origin HEAD", cwd)).toMatchObject({ block: true });
	});

	it("does not record 'unavailable' for an explicitly requested model or an ordinary failure", async () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", task: "Review", cwd, model: "nope/none" } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: true, details: { results: [unavailable] } });
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r2", input: { agent: "code-reviewer", task: "Review", cwd } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r2", input: {}, isError: true, details: { results: [{ ...unavailable, stderr: "worker crashed" }] } });
		expect(pi.entries).toHaveLength(0);
		expect(await deliver(pi, "git push origin HEAD", cwd)).toMatchObject({ block: true });
	});

	it("restores tree and unavailable records from the session", async () => {
		const pi = createFakePi(); const fake: ReviewDiff = { repo: "/repo", files: ["a.ts", "b.ts"], untracked: [], callerNamed: [], text: "Committed (origin/main merge-base):\ndiff --git a/a.ts b/a.ts\n+code", scope: "branch and working tree vs merge-base", truncatedBytes: 0 };
		registerDeliveryReview(pi.api, () => fake, () => "tree:abc");
		await pi.emit({ type: "session_start" }, { branch: [{ customType: "delivery-review", data: { fingerprint: "old", repo: "/repo", head: null, tree: "tree:abc", unavailable: "No API key found for xai." } }] });
		expect(await deliver(pi, "git push origin HEAD", "/repo", "push")).toBeUndefined();
		const [result] = await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "push", input: {}, isError: false, content: [{ type: "text", text: "ok" }] });
		expect(JSON.stringify(result)).toContain("No API key found for xai.");
	});
});
