import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { captureReleaseDiff, isReviewTarget } from "../extensions/subagent/release-review.ts";
import { captureDeliveryDiff, reviewFingerprint, stampableReview } from "../extensions/subagent/reviewdiff.ts";
import { registerDeliveryReview, scanDeliveryTargets } from "../extensions/subagent/delivery.ts";
import { createFakePi } from "./fake-pi.ts";
import { runSingleDelegation, type DelegationHost } from "../extensions/subagent/delegate.ts";
import { ReviewContinuation } from "../extensions/subagent/review-continuation.ts";
import { ReviewArtifactReads, reviewArtifactText } from "../extensions/subagent/review-artifact.ts";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "release-review-")); dirs.push(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
	writeFileSync(join(cwd, "code.ts"), "export const before = 0;\n"); git("add", "."); git("commit", "-m", "prod"); git("branch", "prod");
	writeFileSync(join(cwd, "code.ts"), Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};\n`).join(""));
	git("add", "."); git("commit", "-m", "release");
	const remote = mkdtempSync(join(tmpdir(), "release-origin-")); dirs.push(remote);
	git("clone", "--bare", cwd, remote); git("remote", "add", "origin", remote); git("fetch", "origin"); git("config","remote.origin.gh-resolved","base");
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	git("checkout", "-b", "merged-feature");
	return { cwd, remote, git };
}
const target = { base: "prod", head: "main" };
const command = "gh pr create --base prod --head main --title release";
function harness(cwd: string) {
	vi.stubEnv("PI_DELIVERY_REVIEW", "1");
	const pi = createFakePi(); registerDeliveryReview(pi.api);
	const deliver = () => pi.emit({ type: "tool_call", toolName: "bash", input: { cwd, command } });
	const review = async (diff = captureReleaseDiff(cwd, target).diff!, reviewTarget: typeof target | null = target) => {
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd, reviewTarget: reviewTarget ?? undefined } });
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: false,
			details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(diff) }] } });
	};
	return { pi, deliver, review };
}

describe("explicit origin release review", () => {
	it.each([false, true])("supplies the actual target patch to a spawned reviewer and revalidates its result (remote movement=%s)", async moves => {
		const { cwd, remote, git } = fixture();
		const scratch = mkdtempSync(join(tmpdir(), "release-worker-")); dirs.push(scratch);
		const bin = join(scratch, "pi"), promptPath = join(scratch, "prompt");
		writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(promptPath)}, fs.readFileSync(0,"utf8"));
if (${moves}) {
 const cp = require("node:child_process");
 const args = ["--git-dir", ${JSON.stringify(remote)}];
 const sha = cp.execFileSync("git", [...args, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit-tree", ${JSON.stringify(git("rev-parse", "prod^{tree}"))}, "-p", "prod", "-m", "base moved"], {encoding:"utf8"}).trim();
 cp.execFileSync("git", [...args, "update-ref", "refs/heads/prod", sha]);
}
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Complete review. No findings."}],stopReason:"stop"}}));
`);
		chmodSync(bin, 0o755); vi.stubEnv("PI_HOUSE_PI_BIN", bin);
		const host: DelegationHost = {
			cwd, agents: [{name:"code-reviewer", description:"review",tools:["read"],systemPrompt:"Review independently.",source:"package",filePath:""}],
			modelEnv:{isConfigured:()=>true,catalog:async()=>[]}, signal:undefined,
			makeDetails:mode=>results=>({mode,agentScope:"user",projectAgentsDir:null,results}),
		};
		const expected = captureReleaseDiff(cwd,target).diff!;
		const result = await runSingleDelegation({agent:"code-reviewer", task:"This release is safe", model:"zai/glm-low",reviewTarget:target}, "off", host);
		const prompt = readFileSync(promptPath,"utf8");
		expect(prompt).toContain("explicit origin PR target"); expect(prompt).toContain(expected.text);
		expect(prompt).not.toContain("This release is safe");
		if (moves) { expect(result.isError).toBe(true); expect(result.results[0].reviewFingerprint).toBeUndefined(); }
		else expect(result.results[0].reviewFingerprint).toBe(reviewFingerprint(expected));
	});
	it("rechecks explicit target evidence on retained-review continuation", () => {
		const {cwd,git} = fixture(), diff = captureReleaseDiff(cwd,target).diff!;
		const reads = new ReviewArtifactReads("/tmp/unused-release-patch", diff.text, cwd);
		const continuation = new ReviewContinuation(cwd,"review",reviewFingerprint(diff),reads,target);
		try {
			expect(continuation.unchanged()).toBe(true);
			git("checkout","prod"); git("commit","--allow-empty","-m","base moved"); git("push","origin","prod"); git("checkout","merged-feature");
			expect(continuation.unchanged()).toBe(false);
		} finally { continuation.cleanup(); }
	});
	it("wraps large encoded gzip evidence losslessly without encoding ordinary patch/data lines", () => {
		const { cwd, git } = fixture();
		const plain = Array.from({ length: 5000 }, (_, i) => `${i},${createHash("sha256").update(String(i)).digest("hex")}\n`).join("");
		const compressed = gzipSync(plain);
		writeFileSync(join(cwd, "data.csv.gz"), compressed); git("add", "."); git("commit", "-m", "data"); git("push", "origin", "HEAD:main");
		const diff = captureReleaseDiff(cwd, target).diff!;
		const encoded = /Encoded gzip blob [^\n]+:\n([A-Za-z0-9+/=\n]+)\n\nDecoded gzip asset/.exec(diff.text)![1];
		expect(Buffer.from(encoded, "base64")).toEqual(compressed);
		expect(encoded.trim().split("\n").every(line => line.length <= 76)).toBe(true);
		expect(diff.text).toContain(plain); expect(reviewArtifactText(diff.text).chunked).toBe(false);
	});
	it.each([false,true])("inspects binary objects independently of text-forcing attributes (%s)", forceText => {
		const {cwd,git} = fixture();
		if (forceText) writeFileSync(join(cwd,".gitattributes"),"*.gz diff\n*.bin diff\n");
		writeFileSync(join(cwd,"data.gz"),gzipSync("name,value\nasset,123\n")); git("add","."); git("commit","-m","binary"); git("push","origin","HEAD:main");
		const diff = captureReleaseDiff(cwd,target).diff!;
		expect(diff.files).toContain("data.gz"); if (!forceText) expect(diff.text).toContain("GIT binary patch"); expect(diff.text).toContain("Decoded gzip asset"); expect(diff.text).toContain("name,value\nasset,123\n");
		expect(stampableReview(diff)).toBe(true);
		expect(stampableReview({...diff, text:"Binary files a/x and b/x differ"})).toBe(false);
		expect(stampableReview({...diff,scope:"branch and working tree vs merge-base"})).toBe(false);
		expect(stampableReview({...diff,truncatedBytes:1})).toBe(false);
		expect(stampableReview({...diff,binaryEvidence:undefined})).toBe(false);
		writeFileSync(join(cwd,"unknown.bin"),Buffer.from([0,1,2,0])); git("add","."); git("commit","-m","unknown binary"); git("push","origin","HEAD:main");
		expect(captureReleaseDiff(cwd,target).reason).toContain("unsupported binary asset");
	});
	it("rejects active clean filters that hide reviewer-visible source edits", () => {
		const {cwd,git} = fixture(); writeFileSync(join(cwd,".gitattributes"),"code.ts filter=hide\n");
		git("add","."); git("commit","-m","filtered source"); git("push","origin","HEAD:main");
		git("config","filter.hide.clean","cat >/dev/null; git show HEAD:code.ts"); writeFileSync(join(cwd,"code.ts"),"export const safeLooking = true;\n"); git("add","code.ts");
		expect(git("status","--porcelain")).toBe(""); expect(captureReleaseDiff(cwd,target).reason).toContain("active source filters");
	});
	it.each(["--assume-unchanged","--skip-worktree"])("rejects index flags hiding source edits (%s)", flag => {
		const {cwd,git} = fixture(); git("update-index",flag,"code.ts");
		writeFileSync(join(cwd,"code.ts"),"hidden caller fix\n"); expect(git("status","--porcelain")).toBe("");
		expect(captureReleaseDiff(cwd,target).reason).toContain("index flags");
	});
	it("retains changed gitlinks even when diff.ignoreSubmodules hides them by default", () => {
		const {cwd,git} = fixture(), sha = git("rev-parse","HEAD");
		mkdirSync(join(cwd,"vendor/sub"),{recursive:true}); git("update-index","--add","--cacheinfo",`160000,${sha},vendor/sub`);
		writeFileSync(join(cwd,".gitmodules"),'[submodule "dep"]\npath = vendor/sub\nurl = ignored\n'); git("add",".gitmodules");
		git("commit","-m","submodule"); git("push","origin","HEAD:main"); git("config","diff.ignoreSubmodules","all");
		writeFileSync(join(cwd,"vendor/sub/stale.ts"),"uninitialized stale dependency\n");
		expect(captureReleaseDiff(cwd,target).reason).toContain("initialize every submodule"); rmSync(join(cwd,"vendor/sub/stale.ts"));
		git("-C","vendor/sub","init"); git("-C","vendor/sub","fetch",cwd,sha); git("-C","vendor/sub","checkout",sha); git("submodule","init");
		const captured = captureReleaseDiff(cwd,target); expect(captured.diff,captured.reason).not.toBeNull();
		const diff = captured.diff!;
		expect(diff.files).toContain("vendor/sub"); expect(diff.text).toContain(`Subproject commit ${sha}`);
		git("-C","vendor/sub","-c","user.name=test","-c","user.email=test@example.com","commit","--allow-empty","-m","stale source");
		expect(captureReleaseDiff(cwd,target).reason).toContain("recorded source commit");
		writeFileSync(join(cwd,"vendor/sub/dependency.ts"),"export const contract = 1;\n"); git("-C","vendor/sub","add",".");
		git("-C","vendor/sub","-c","user.name=test","-c","user.email=test@example.com","commit","-m","dependency");
		writeFileSync(join(cwd,".gitmodules"),'[submodule "dep"]\npath = vendor/sub\nurl = ignored\n');
		git("add","."); git("commit","-m","registered submodule"); git("push","origin","HEAD:main");
		git("-C","vendor/sub","update-index","--assume-unchanged","dependency.ts"); writeFileSync(join(cwd,"vendor/sub/dependency.ts"),"hidden caller fix\n");
		expect(captureReleaseDiff(cwd,target).reason).toContain("submodule index flags");
	});
	it("captures the whole release from a subdirectory even with diff.relative configured", () => {
		const {cwd,git} = fixture();
		mkdirSync(join(cwd,"docs")); writeFileSync(join(cwd,"docs/release.md"),"release\n"); git("add","."); git("commit","-m","notes"); git("push","origin","HEAD:main");
		git("config","diff.relative","true");
		const diff = captureReleaseDiff(join(cwd,"docs"),target).diff!;
		expect(diff.files).toEqual(["code.ts","docs/release.md"]); expect(diff.text).toContain("export const value11");
	});
	it("captures the release rather than an empty already-merged feature diff and gates it on a matching review", async () => {
		const { cwd } = fixture(), h = harness(cwd);
		expect(captureDeliveryDiff(cwd)!.files).toEqual([]);
		const diff = captureReleaseDiff(cwd, target).diff!;
		expect(diff.files).toEqual(["code.ts"]); expect(diff.text).toContain("export const value11");
		expect(diff.text).toContain('"baseRef":"refs/heads/prod"');
		expect(scanDeliveryTargets(command, cwd)).toEqual([{ target: cwd, reviewTarget: target }]);
		expect((await h.deliver())[0]).toMatchObject({ block: true, reason: expect.stringContaining("reviewTarget") });
		await h.review(captureDeliveryDiff(cwd)!, null);
		expect((await h.deliver())[0]).toMatchObject({ block: true });
		await h.review(); expect((await h.deliver())[0]).toBeUndefined();
	});
	it.each(["prod", "main"])("invalidates a review when remote %s moves even with identical patch bytes", async branch => {
		const { cwd, git } = fixture(), h = harness(cwd);
		const before = captureReleaseDiff(cwd, target).diff!;
		await h.review(); expect((await h.deliver())[0]).toBeUndefined();
		git("checkout", branch); git("commit", "--allow-empty", "-m", "endpoint moved"); git("push", "origin", branch); git("checkout", "merged-feature");
		const after = captureReleaseDiff(cwd, target).diff!;
		expect(after.text.split("\n").slice(1)).toEqual(before.text.split("\n").slice(1));
		expect(reviewFingerprint(after)).not.toBe(reviewFingerprint(before));
		expect((await h.deliver())[0]).toMatchObject({ block: true });
		// A result for the old evidence cannot stamp the new endpoint pair.
		await h.review(before); expect((await h.deliver())[0]).toMatchObject({ block: true });
		await h.review(); expect((await h.deliver())[0]).toBeUndefined();
	});
	it("rehydrates only matching persisted endpoint evidence", async () => {
		const {cwd,git} = fixture(), h = harness(cwd); await h.review();
		const restored = createFakePi(); registerDeliveryReview(restored.api);
		await restored.emit({type:"session_start"},{cwd,branch:h.pi.entries});
		const deliver = () => restored.emit({type:"tool_call",toolName:"bash",input:{cwd,command}});
		expect((await deliver())[0]).toBeUndefined();
		git("checkout","prod"); git("commit","--allow-empty","-m","new base"); git("push","origin","prod"); git("checkout","merged-feature");
		expect((await deliver())[0]).toMatchObject({block:true});
	});
	it("does not accept another repository's fingerprint or background/error results", async () => {
		const a = fixture(), b = fixture(), h = harness(a.cwd);
		await h.review(captureReleaseDiff(b.cwd, target).diff!); expect((await h.deliver())[0]).toMatchObject({ block: true });
		await h.pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd: a.cwd, reviewTarget: target, background: true } });
		await h.pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: false,
			details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(captureReleaseDiff(a.cwd, target).diff!) }] } });
		expect((await h.deliver())[0]).toMatchObject({ block: true });
		await h.pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "failed", input: { agent: "code-reviewer", cwd: a.cwd, reviewTarget: target } });
		await h.pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "failed", input: {}, isError: true,
			details: { results: [{ agent: "code-reviewer", exitCode: 0, reviewFingerprint: reviewFingerprint(captureReleaseDiff(a.cwd, target).diff!) }] } });
		expect((await h.deliver())[0]).toMatchObject({ block: true });
	});
	it("requires live remote refs, available objects and the clean source tree, not stale tracking refs", () => {
		const { cwd, remote, git } = fixture();
		expect(captureReleaseDiff(cwd, { base: "missing", head: "main" }).reason).toContain("exist on origin");
		writeFileSync(join(cwd, "code.ts"), "dirty\n"); expect(captureReleaseDiff(cwd, target).reason).toContain("clean source tree"); git("checkout", "--", "code.ts");
		git("checkout", "prod"); expect(captureReleaseDiff(cwd, target).reason).toContain("same committed tree"); git("checkout", "merged-feature");
		const tree = git("rev-parse", "main^{tree}");
		const newHead = execFileSync("git", ["--git-dir", remote, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit-tree", tree, "-p", "main", "-m", "remote only"], { encoding: "utf8" }).trim();
		execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/main", newHead]);
		expect(captureReleaseDiff(cwd, target).reason).toContain("objects are missing");
	});
	it("refuses partial clones without hydrating missing local blobs", () => {
		const {cwd,git} = fixture(), blob=git("rev-parse","prod:code.ts");
		const path=join(cwd,".git/objects",blob.slice(0,2),blob.slice(2)); rmSync(path);
		git("config","remote.origin.promisor","true");
		expect(captureReleaseDiff(cwd,target).reason).toContain("partial clones");
		expect(() => readFileSync(path)).toThrow();
	});
	it("rejects gh upstream-fork resolution that differs from origin", () => {
		const {cwd,git} = fixture(); git("config","--unset","remote.origin.gh-resolved"); git("remote","set-url","origin","git@github.com:fork/repo.git");
		const scratch = mkdtempSync(join(tmpdir(),"gh-target-")); dirs.push(scratch);
		writeFileSync(join(scratch,"gh"),"#!/bin/sh\nprintf 'https://github.com/upstream/repo\\n'\n"); chmodSync(join(scratch,"gh"),0o755);
		vi.stubEnv("PATH",`${scratch}:${process.env.PATH}`);
		expect(captureReleaseDiff(cwd,target).reason).toContain("other than origin");
	});
	it("refuses ambiguous repository selection and does not exempt an explicit docs-only target", async () => {
		const { cwd, git } = fixture(), h = harness(cwd);
		git("remote", "add", "other", cwd); expect(captureReleaseDiff(cwd, target).reason).toContain("exactly one remote"); git("remote", "remove", "other");
		git("config","remote.origin.pushurl","https://github.com/another/repo.git"); expect(captureReleaseDiff(cwd,target).reason).toContain("push URLs"); git("config","--unset","remote.origin.pushurl");
		git("config", "url.example.insteadOf", "elsewhere"); expect(captureReleaseDiff(cwd, target).reason).toContain("rewrites"); git("config", "--unset", "url.example.insteadOf");
		vi.stubEnv("GH_REPO", "another/repo"); expect(captureReleaseDiff(cwd, target).reason).toContain("GH_REPO"); vi.unstubAllEnvs(); vi.stubEnv("PI_DELIVERY_REVIEW", "1");
		git("checkout", "main"); git("checkout", "prod", "--", "code.ts"); writeFileSync(join(cwd, "README.md"), "release notes\n"); git("add", "."); git("commit", "-m", "docs only release"); git("push", "origin", "main");
		expect(captureReleaseDiff(cwd, target).diff!.files).toEqual(["README.md"]);
		expect((await h.deliver())[0]).toMatchObject({ block: true });
	});
	it("accepts paired literal aliases/equal forms, retains fail-closed unsafe-command handling", () => {
		for (const args of ["--base prod --head main", "--head=main --base=prod", "-B prod -H main"]) {
			expect(scanDeliveryTargets(`gh pr create ${args} --body 'supports --base'`, "/repo")).toEqual([{ target: "/repo", reviewTarget: target }]);
		}
		for (const c of ["gh pr create --base prod", "gh pr create --head main", "gh pr create --base prod --head fork:main", "gh pr create --base prod --head main --repo other/repo", "gh pr create --base prod --head main --base dev", "gh pr create --base prod --head main --web", "GH_REPO=x/y gh pr create --base prod --head main", "git checkout main && gh pr create --base prod --head main", "gh pr create --base prod --head $(echo main)", "gh pr create --base prod --head main | cat"]) {
			expect(scanDeliveryTargets(c, "/repo")[0].target, c).toBeNull();
		}
		for (const head of ["main..other", "-main", "refs/heads/a.lock", "a//b", "a/../b", "fork:main", "a@{1}"]) expect(isReviewTarget({ base: "prod", head }), head).toBe(false);
	});
});
