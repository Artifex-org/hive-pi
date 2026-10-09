import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryCommand, deliveryTargets, needsDeliveryReview, registerDeliveryReview, reviewFingerprint } from "../extensions/subagent/delivery.ts";
import { BASE_REF_SCAN, fetchedBaseRef, knownBaseRef } from "../extensions/guards-common/git-base.ts";
import { captureDeliveryDiff, neutralReviewTask, reviewTaskWithDiff, type ReviewDiff } from "../extensions/subagent/reviewdiff.ts";
import { createFakePi } from "./fake-pi.ts";
const diff: ReviewDiff = { repo: "/repo", files: ["a.ts", "b.ts"], untracked: [], callerNamed: [], text: "diff --git a/a.ts b/a.ts\n+code\n-code", scope: "working tree vs HEAD", truncatedBytes: 0 };
const repos: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repo() {
	const cwd = mkdtempSync(join(tmpdir(), "delivery-")); repos.push(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
	writeFileSync(join(cwd, "code.ts"), "export const n = 0;\n"); writeFileSync(join(cwd, "README.md"), "base\n");
	git("add", "."); git("commit", "-m", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
	return { cwd, git };
}
const substantive = Array.from({ length: 12 }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n";

describe("delivery review", () => {
	it.each([
		"hive ship --no-pr && gh pr create",
		"hive ship --no-pr && gh pr create --title 'review stamped'",
		"HIVE_PRESIGN_REQUIRED=1 git push",
		"git commit -m 'code && docs' && hive ship && git push",
		"git status; FORCE_COLOR='1 2' HIVE_PRESIGN_REQUIRED=1 git push",
	])("requires a matching review for %s", async command => {
		const { cwd, git } = repo();
		writeFileSync(join(cwd, "code.ts"), substantive); git("add", ".");
		vi.stubEnv("PI_DELIVERY_REVIEW", "1");
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		const deliver = () => pi.emit({ type: "tool_call", toolName: "bash", input: { command, cwd } });
		const refused = (await deliver())[0] as { block: boolean; reason: string };
		expect(refused.block).toBe(true);
		expect(refused.reason).toContain("no matching completed foreground review");
		expect(refused.reason).not.toContain("diff unavailable");
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: false,
			details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(captureDeliveryDiff(cwd)!) }] } });
		expect((await deliver())[0]).toBeUndefined();
		writeFileSync(join(cwd, "code.ts"), substantive + "export const later = 1;\n"); git("add", ".");
		expect((await deliver())[0]).toMatchObject({ block: true, reason: expect.stringContaining("no matching") });
	});
	it("checks the last delivery first without hiding earlier unsupported pushes", () => {
		expect(deliveryTargets("git -C /first push && cd /last && gh pr create", "/repo")).toEqual(["/last", "/first"]);
		expect(deliveryTargets("git push other HEAD && gh pr create", "/repo")).toEqual(["/repo", null]);
	});
	it("does not authorize alternate configuration or ignored files staged by force", async () => {
		const { cwd, git } = repo();
		writeFileSync(join(cwd, ".gitignore"), "generated.ts\n"); git("add", "."); git("commit", "-m", "ignore");
		writeFileSync(join(cwd, "generated.ts"), substantive);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		expect(needsDeliveryReview(captureDeliveryDiff(cwd)!)).toBe(false);
		for (const command of ["git add -f generated.ts && git commit -m code && git push",
			"git add --force generated.ts; hive ship", `git -C "${cwd}" add -f generated.ts && git push`,
			"HOME=/other git push", "XDG_CONFIG_HOME=/other git push",
			"git status > code.ts; git add code.ts; git commit -m code; git push",
			'SETTING="$(echo changed >> code.ts)" git push',
			'SETTING=$(echo changed >> code.ts) git push',
			'git status "$(echo changed >> code.ts)" && git push']) {
			expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command, cwd } }))[0])
				.toMatchObject({ block: true, reason: expect.stringContaining("Unsupported command shape") });
		}
	});
	it("distinguishes unsupported shapes from an unavailable diff", async () => {
		const pi = createFakePi(); registerDeliveryReview(pi.api, () => null);
		for (const command of ["git checkout work && git push", "git push other HEAD"]) {
			const result = (await pi.emit({ type: "tool_call", toolName: "bash", input: { command } }))[0] as { reason: string };
			expect(result.reason).toContain("Unsupported command shape:");
			expect(result.reason).toContain("standalone");
			expect(result.reason).not.toContain("diff unavailable");
		}
		expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git push" } }))[0])
			.toMatchObject({ block: true, reason: expect.stringContaining("Complete delivery diff unavailable") });
	});
	it("recognizes real delivery, not echo, status, dry runs, or PR reads", () => {
		for (const c of ["git push -u origin HEAD", "git -C /repo push", "git push && gh pr create", "gh pr create --title 'change'", "git status\ngit push",  'gh pr create --body "$(cat body.md)"']) expect(deliveryCommand(c), c).toBe(true);
		for (const c of ["echo 'git push'", "git push --dry-run", "git status", "gh pr view", "cat README.md", 'echo "git status\ngit push"']) expect(deliveryCommand(c), c).toBe(false);
	});
	it("recognizes gh global options without treating quoted body prose as options", () => {
		expect(deliveryTargets("gh --repo owner/repo pr create --title change --body description", "/repo")).toEqual([null]);
		for (const body of ['"Adds support for --base selection"', '"--base"', '"$(cat body.md)"']) expect(deliveryTargets(`gh pr create --title change --body ${body}`, "/repo")).toEqual(["/repo"]);
	});
	it("ignores forced Git color when deciding whether code is substantive", () => {
		const { cwd, git } = repo(); git("config", "color.diff", "always");
		writeFileSync(join(cwd, "code.ts"), substantive); git("add", "."); git("commit", "-m", "code");
		const change = captureDeliveryDiff(cwd)!;
		expect(change.text).not.toContain("\u001b["); expect(needsDeliveryReview(change)).toBe(true);
	});
	it("cheaply exempts docs-only and a single <=5-line change, not untracked code or large diffs", () => {
		expect(needsDeliveryReview({ ...diff, files: ["README.md", "docs/a.rst"] })).toBe(false);
		expect(needsDeliveryReview({ ...diff, files: ["a.ts"] })).toBe(false);
		expect(needsDeliveryReview({ ...diff, files: ["a.ts"], untracked: ["new.ts"] })).toBe(true);
		expect(needsDeliveryReview({ ...diff, files: ["a.ts"], truncatedBytes: 1 })).toBe(true);
		expect(needsDeliveryReview({ ...diff, files: ["image.png"], text: "Binary files a/image.png and b/image.png differ" })).toBe(true);
	});
	it("removes author's conclusions, keeps diff/file list and extra scope paths", () => {
		const task = reviewTaskWithDiff("Check conservative outcome_unknown semantics; this design is safe", { ...diff, callerNamed: ["other.ts"] }, true);
		expect(task).not.toContain("conservative outcome_unknown"); expect(task).not.toContain("this design is safe");
		for (const s of ["a.ts", "b.ts", "other.ts", "+code", "Review the change independently"]) expect(task).toContain(s);
	});
	it("preserves a non-Git scope path without echoing the author's framing", () => {
		const task = neutralReviewTask("Review /tmp/example.ts; my design is safe");
		expect(task).toContain("/tmp/example.ts"); expect(task).not.toContain("my design is safe");
	});
	it("reviews committed code even with unrelated dirty docs (bare clone without origin/HEAD)", () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive);
		git("add", "."); git("commit", "-m", "code"); writeFileSync(join(cwd, "README.md"), "dirty docs\n");
		const change = captureDeliveryDiff(cwd)!;
		expect(change.files).toEqual(["README.md", "code.ts"]); expect(change.text).toContain("export const n11");
		expect(needsDeliveryReview(change)).toBe(true);
	});
	it("targets git -C/cd repositories and requires review of the final committed diff", async () => {
		const a = repo(), b = repo(); writeFileSync(join(b.cwd, "code.ts"), substantive);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		const push = (command: string) => pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "push", input: { command } }, { cwd: a.cwd });
		for (const command of [`git -C '${b.cwd}' push`, `cd '${b.cwd}' && git push`]) expect((await push(command))[0]).toMatchObject({ block: true });
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd: b.cwd } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: false, details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(captureDeliveryDiff(b.cwd)!) }] } });
		b.git("add", "."); b.git("commit", "-m", "code");
		expect((await push(`git -C '${b.cwd}' push`))[0]).toMatchObject({ block: true });
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "final", input: { agent: "code-reviewer", cwd: b.cwd } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "final", input: {}, isError: false, details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(captureDeliveryDiff(b.cwd)!) }] } });
		expect((await push(`git -C '${b.cwd}' push`))[0]).toBeUndefined();
		writeFileSync(join(b.cwd, "code.ts"), substantive + "export const later = 1;\n");
		expect((await push(`git -C '${b.cwd}' push`))[0]).toMatchObject({ block: true });
	});
	it("never lets a dirty or staged revert erase committed delivery evidence", () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive);
		git("add", "."); git("commit", "-m", "code");
		writeFileSync(join(cwd, "code.ts"), "export const n = 0;\n");
		for (const staged of [false, true]) {
			if (staged) git("add", ".");
			const change = captureDeliveryDiff(cwd)!;
			expect(change.text).toContain("Committed"); expect(change.text).toContain("export const n11");
			expect(needsDeliveryReview(change)).toBe(true);
		}
	});
	it("refuses a local main with no remote baseline, including direct commits", () => {
		const { cwd, git } = repo(); git("update-ref", "-d", "refs/remotes/origin/main"); git("checkout", "main");
		writeFileSync(join(cwd, "code.ts"), substantive); git("add", "."); git("commit", "-m", "code");
		expect(captureDeliveryDiff(cwd)).toBeNull();
	});
	it("explicitly refuses dynamic/configured/over-budget delivery targets", () => {
		for (const c of ['git -C "$REPO" push', "git -c core.worktree=/other push", "GIT_DIR=/other git push", "git push origin feature-branch", "git push --all", "git push other HEAD", "git push https://elsewhere/repo.git HEAD", "cd /clean | cat\ngit push", "git checkout work && git push origin HEAD", "gh pr create --head work --base main",    "echo " + "x".repeat(8200) + " && git push"]) expect(deliveryTargets(c, "/repo")).toEqual([null]);
		expect(deliveryTargets("git -C /repo -C child push", "/tmp")).toEqual(["/repo/child"]);
		expect(deliveryCommand("git -c x=y status")).toBe(false);
	});
	it("accepts only origin-matched main/master FETCH_HEAD records, never local branch guesses", () => {
		const sha = "a".repeat(40), record = `${sha}\t\tbranch 'main' of https://example.com/repo`;
		expect(knownBaseRef(null, "refs/heads/main")).toBeNull(); expect(BASE_REF_SCAN).not.toContain("refs/heads/main");
		expect(fetchedBaseRef(record, "https://user:token@example.com/repo.git")).toBe(sha);
		for (const source of [record.replace("repo", "elsewhere"), record.replace("'main'", "'work'"), record.replace(sha, "not-sha")]) expect(fetchedBaseRef(source, "https://example.com/repo.git")).toBeNull();
	});
	it("uses real origin FETCH_HEAD evidence in a bare-style local-only ref layout", () => {
		const remote = repo(), local = repo();
		local.git("remote", "add", "origin", remote.cwd); local.git("fetch", "origin", "main");
		local.git("update-ref", "-d", "refs/remotes/origin/main");
		const sha = local.git("rev-parse", "FETCH_HEAD").trim(); local.git("reset", "--hard", sha);
		writeFileSync(join(local.cwd, "code.ts"), substantive); local.git("add", "."); local.git("commit", "-m", "code");
		expect(captureDeliveryDiff(local.cwd)?.text).toContain("export const n11");
	});
	it("refuses mirror/follow-tag configuration and pipeline-local checkouts end to end", async () => {
		for (const key of ["remote.origin.mirror", "push.followTags"]) {
			const { cwd, git } = repo(); git("config", key, "true"); expect(captureDeliveryDiff(cwd)).toBeNull();
		}
		const original = repo(), clean = repo(); writeFileSync(join(original.cwd, "code.ts"), substantive);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		for (const command of [`cd '${clean.cwd}' | cat\ngit push`, "git push other HEAD"]) expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command, cwd: original.cwd } }))[0]).toMatchObject({ block: true });
	});
	it("does not treat origin's fetch URL as evidence for an alternate push URL", async () => {
		const destination = repo(), source = repo();
		source.git("remote", "add", "origin", destination.cwd);
		source.git("fetch", "origin", "main"); source.git("reset", "--hard", "origin/main");
		expect(needsDeliveryReview(captureDeliveryDiff(source.cwd)!)).toBe(false);
		const other = repo(); source.git("config", "remote.origin.pushurl", other.cwd);
		expect(captureDeliveryDiff(source.cwd)).toBeNull();
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git push origin HEAD", cwd: source.cwd } }))[0]).toMatchObject({ block: true });
	});
	it("refuses default pushes configured to send non-HEAD branches", () => {
		const { cwd, git } = repo();
		git("config", "push.default", "matching"); expect(captureDeliveryDiff(cwd)).toBeNull();
		git("config", "push.default", "simple"); git("config", "remote.origin.push", "refs/heads/other");
		expect(captureDeliveryDiff(cwd)).toBeNull();
	});
	it("does not exempt a non-HEAD push just because current HEAD is clean", async () => {
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", "."); git("commit", "-m", "code"); git("checkout", "main");
		expect(needsDeliveryReview(captureDeliveryDiff(cwd)!)).toBe(false);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git push origin work", cwd } }))[0]).toMatchObject({ block: true });
	});
	it("refuses configured non-origin default destinations and branch switches", async () => {
		for (const key of ["remote.pushDefault", "branch.work.pushRemote", "branch.work.remote"]) {
			const { cwd, git } = repo(); git("config", key, "release"); expect(captureDeliveryDiff(cwd)).toBeNull();
		}
		const { cwd, git } = repo(); writeFileSync(join(cwd, "code.ts"), substantive); git("add", "."); git("commit", "-m", "code"); git("checkout", "main");
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		for (const command of ["git checkout work && git push origin HEAD", "gh pr create --head work --base main"]) expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command, cwd } }))[0]).toMatchObject({ block: true });
	});
	it("cannot stamp pre-launch evidence that differs from what the worker reviewed", async () => {
		const pi = createFakePi(); let current = diff; registerDeliveryReview(pi.api, () => current);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd: "/repo" } });
		const worker = { ...diff, text: diff.text + "\n+worker-only change" };
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: false, details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(worker) }] } });
		const push = () => pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git push", cwd: "/repo" } });
		expect((await push())[0]).toMatchObject({ block: true });
		current = worker; expect((await push())[0]).toMatchObject({ block: true });
		expect(pi.entries).toHaveLength(0);
	});
	it("never stamps an untracked file's name as a content review", async () => {
		const { cwd } = repo(); writeFileSync(join(cwd, "new.ts"), substantive);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: false, details: { results: [{ agent: "code-reviewer", exitCode: 0 }] } });
		writeFileSync(join(cwd, "new.ts"), "unreviewed\n");
		expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git add . && git commit -m code && git push", cwd } }))[0]).toMatchObject({ block: true });
	});
	it("blocks actual delivery until a completed foreground code review; a later edit needs another review", async () => {
		vi.stubEnv("PI_DELIVERY_REVIEW", "1"); const pi = createFakePi(); let current = diff;
		registerDeliveryReview(pi.api, () => current);
		const push = () => pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "push", input: { command: "git push" } }, { cwd: "/repo" });
		expect((await push())[0]).toMatchObject({ block: true, reason: expect.stringContaining("code-reviewer") });
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "review", input: { agent: "code-reviewer", task: "Review" } }, { cwd: "/repo" });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "review", isError: false, input: {}, details: { results: [{ agent: "code-reviewer", exitCode: 0, stopReason: "end", reviewFingerprint: reviewFingerprint(current) }] } });
		expect((await push())[0]).toBeUndefined();
		current = { ...diff, text: diff.text + "\n+another edit" }; expect((await push())[0]).toMatchObject({ block: true });
	});
	it("a failed or background-started review does not unlock delivery", async () => {
		vi.stubEnv("PI_DELIVERY_REVIEW", "1"); const pi = createFakePi(); registerDeliveryReview(pi.api, () => diff);
		for (const background of [false, true]) {
			await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", background } });
			await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", isError: false, input: {}, details: { results: background ? [] : [{ agent: "code-reviewer", exitCode: 1 }] } });
			expect((await pi.emit({ type: "tool_call", toolName: "background_bash", toolCallId: "p", input: { command: "gh pr create" } }))[0]).toMatchObject({ block: true });
		}
	});
	it("allows an explicit session or call override, without recording a review", async () => {
		const pi = createFakePi(); registerDeliveryReview(pi.api, () => diff);
		vi.stubEnv("PI_DELIVERY_REVIEW", "0");
		expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git push" } }))[0]).toBeUndefined();
		vi.stubEnv("PI_DELIVERY_REVIEW", "1");
		expect((await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "PI_DELIVERY_REVIEW=0 git push" } }))[0]).toBeUndefined();
		expect(pi.entries).toHaveLength(0);
	});
});
