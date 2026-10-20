import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, promises } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { captureReleaseDiff } from "../extensions/subagent/release-review.ts";
import { captureDeliveryDiff, reviewFingerprint, reviewTaskWithDiff, stampableReview, type GitRunner } from "../extensions/subagent/reviewdiff.ts";
import { registerDeliveryReview } from "../extensions/subagent/delivery.ts";
import { runSingleDelegation, type DelegationHost } from "../extensions/subagent/delegate.ts";
import { makeLaunch, type LaunchEnv } from "./claude-harness.ts";
import { createFakePi } from "./fake-pi.ts";

let launch: LaunchEnv;
const frozen = JSON.stringify(Array.from({ length: 12000 }, (_, i) => ({ i, value: "frozen" })), null, 2);
const git = (...args: string[]) => execFileSync("git", args, { cwd: launch.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
beforeEach(() => {
	launch = makeLaunch();
	vi.stubEnv("PI_HOUSE_PI_BIN", launch.piBin);
	git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
	writeFileSync(join(launch.root, ".git", "info", "exclude"), "pi-calls.jsonl\npi-replies.json\npatch-log.json\n");
	git("add", "."); git("commit", "-m", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
	writeFileSync(join(launch.root, "frozen.json"), frozen);
	for (let i = 0; i < 25; i++) writeFileSync(join(launch.root, `code${i}.ts`), `export const value${i} = 1;\n`);
	git("add", "."); git("commit", "-m", "large change");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(launch.root, { recursive: true, force: true }); });

const host = (): DelegationHost => ({
	cwd: launch.root,
	agents: [{ name: "code-reviewer", description: "r", tools: ["read"], systemPrompt: "Review independently.", source: "package", filePath: "" }],
	modelEnv: { isConfigured: () => true, catalog: async () => [] }, signal: undefined,
	makeDetails: (mode) => (results) => ({ mode, agentScope: "user", projectAgentsDir: null, results }),
});

// A real spawned worker reads the supplied artifact while it exists, rather
// than pretending that a digest or a preview equals full review evidence.
function artifactWorker(reply = "Complete review; no findings.", exit = 0, pages = "all", splitUtf8 = false, pathPrefix = "") {
	writeFileSync(launch.piBin, `#!${process.execPath}
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
const path = prompt.match(/Complete captured patch: (.+) \\(\\d+ bytes,/)[1];
const patch = fs.readFileSync(path, "utf8");
const decodedAt = patch.search(/^Decoded gzip asset /m);
const encodedEnd = decodedAt < 0 ? patch.split("\\n").length : patch.slice(0,decodedAt).split("\\n").length - 1;
let readThrough = 0;
(async () => {
const {createReadToolDefinition} = await import(${JSON.stringify(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js"))});
const read = createReadToolDefinition(${JSON.stringify(launch.root)});
let splitWrites = 0;
const emit = async event => {
 const bytes = Buffer.from(JSON.stringify(event) + "\\n");
 const at = ${JSON.stringify(splitUtf8)} ? bytes.indexOf(Buffer.from("é")) : -1;
 if (at >= 0) {
  splitWrites++;
  process.stdout.write(bytes.subarray(0, at + 1));
  await new Promise(resolve => setTimeout(resolve, 20));
  process.stdout.write(bytes.subarray(at + 1));
 } else process.stdout.write(bytes);
};
if (${JSON.stringify(pages)} !== "none") for(let offset = 1; offset <= patch.split("\\n").length; ) {
 const readPath = ${JSON.stringify(pathPrefix)} === "@" ? "@" + path : ${JSON.stringify(pathPrefix)} === "file" ? require("node:url").pathToFileURL(path).href : path;
 if (${JSON.stringify(pages)} === "encoded" && offset > encodedEnd) break;
 const args = {path:readPath, offset, limit:${JSON.stringify(pages)} === "encoded" ? Math.min(1500,encodedEnd-offset+1) : 1500}, toolCallId = "read-" + offset;
 console.log(JSON.stringify({type:"tool_execution_start",toolName:"read",toolCallId,args}));
 const result = await read.execute(toolCallId, args);
 await emit({type:"tool_execution_end",toolName:"read",toolCallId,result,isError:false});
 if (${JSON.stringify(pages)} === "first") break;
 offset += result.details?.truncation?.outputLines ?? Math.min(args.limit, patch.split("\\n").length - offset + 1);
 readThrough = offset - 1;
}
fs.writeFileSync(${JSON.stringify(join(launch.root, "patch-log.json"))}, JSON.stringify({prompt, path, patch, splitWrites, encodedEnd, readThrough, mode: fs.statSync(path).mode & 0o777}));
console.log(JSON.stringify({type:"message_end", message:{role:"assistant", content:[{type:"text", text:${JSON.stringify(reply)}}], stopReason:"stop"}}));
process.stdout.write("", () => process.exit(${exit}));
})().catch(error => {console.error(error); process.exit(1);});
`);
}
const run = () => runSingleDelegation({ agent: "code-reviewer", task: "Review the change", model: "zai/glm-low" }, "off", host());

describe("large delivery review evidence (HIV-3868)", () => {
	it.each(["all", "encoded"])("requires decoded explicit-target binary evidence in the coverage-checked artifact (%s)", async pages => {
		artifactWorker("Complete review; no findings.",0,pages);
		writeFileSync(join(launch.root, "data.gz"), gzipSync("name,value\nasset,123\n")); git("add", "."); git("commit", "-m", "binary and reviewer fixture");
		git("branch", "prod", "main"); git("branch", "-f", "main", "HEAD");
		const remote = await promises.mkdtemp(join(tmpdir(), "large-release-origin-"));
		try {
			git("clone", "--bare", launch.root, remote); git("remote", "add", "origin", remote); git("config","remote.origin.gh-resolved","base");
			const target = {base:"prod",head:"main"}, expected = captureReleaseDiff(launch.root,target).diff!;
			expect(expected.text).toContain("GIT binary patch"); expect(Buffer.byteLength(expected.text)).toBeGreaterThan(256*1024);
			const pi = createFakePi(); registerDeliveryReview(pi.api);
			await pi.emit({type:"tool_call",toolName:"subagent",toolCallId:"release",input:{agent:"code-reviewer",cwd:launch.root,reviewTarget:target}});
			const outcome = await runSingleDelegation({agent:"code-reviewer",task:"Review release",model:"zai/glm-low",reviewTarget:target},"off",host());
			if (pages === "encoded") {
				const log = JSON.parse(readFileSync(join(launch.root,"patch-log.json"),"utf8"));
				expect(log.readThrough).toBe(log.encodedEnd); expect(log.encodedEnd).toBeGreaterThan(1000);
				expect(outcome.isError).toBe(true); expect(outcome.results[0].reviewFingerprint).toBeUndefined();
				await pi.emit({type:"tool_result",toolName:"subagent",toolCallId:"release",input:{},isError:false,details:{results:outcome.results}});
				expect((await pi.emit({type:"tool_call",toolName:"bash",input:{cwd:launch.root,command:"gh pr create --base prod --head main --title release"}}))[0]).toMatchObject({block:true});
				return;
			}
			expect(outcome.isError,outcome.text).toBeUndefined(); expect(outcome.results[0].reviewFingerprint).toBe(reviewFingerprint(expected));
			const log = JSON.parse(readFileSync(join(launch.root,"patch-log.json"),"utf8"));
			expect(log.patch).toBe(expected.text); expect(log.prompt).toContain("decoded gzip text"); expect(log.patch).toContain("name,value\nasset,123\n"); expect(existsSync(log.path)).toBe(false);
			await pi.emit({type:"tool_result",toolName:"subagent",toolCallId:"release",input:{},isError:false,details:{results:outcome.results}});
			expect((await pi.emit({type:"tool_call",toolName:"bash",input:{cwd:launch.root,command:"gh pr create --base prod --head main --title release"}}))[0]).toBeUndefined();
		} finally { rmSync(remote,{recursive:true,force:true}); }
	});
	it("retains all inventories when per-file patch fallback exhausts the scan deadline", () => {
		// Inject scan costs, not a flaky sleep: reproduce an ENOBUFS followed by
		// fallback consuming the budget before the next layer's inventory.
		let elapsed = 0;
		vi.spyOn(Date, "now").mockImplementation(() => elapsed);
		const calls: string[][] = [];
		const runner: GitRunner = (args, cwd, timeout) => {
			calls.push(args);
			if (args.includes("-p")) elapsed += args.includes("--") ? 90 : 400;
			try { return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
			catch { return null; }
		};
		writeFileSync(join(launch.root, "staged.ts"), "export const staged = 1;\n"); git("add", "staged.ts");
		writeFileSync(join(launch.root, "code0.ts"), "export const unstaged = 2;\n");
		const diff = captureDeliveryDiff(launch.root, "Review the change", runner)!;
		expect(diff).not.toBeNull(); expect(diff.files).toHaveLength(27);
		expect(diff.files).toContain("staged.ts"); expect(diff.omitted).toContain("staged.ts");
		expect(diff.omitted).toContain("frozen.json"); expect(stampableReview(diff)).toBe(false);
		expect(reviewTaskWithDiff("Review the change", diff, true)).toContain("- frozen.json");
		const firstPatch = calls.findIndex(args => args.includes("-p"));
		expect(calls.slice(0, firstPatch).filter(args => args.includes("--name-only"))).toHaveLength(3);
	});
	it("captures a complete JSON-heavy patch through the production runner", () => {
		const diff = captureDeliveryDiff(launch.root)!;
		expect(diff.files).toHaveLength(26); expect(diff.truncatedBytes).toBe(0);
		expect(Buffer.byteLength(diff.text)).toBeGreaterThan(256 * 1024);
		expect(diff.text).toContain('+    "i": 11999,'); expect(stampableReview(diff)).toBe(true);
	});
	it("supplies a private complete artifact, stamps that evidence, and rejects edits beyond the preview", async () => {
		artifactWorker();
		const expected = captureDeliveryDiff(launch.root)!;
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		const deliver = () => pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git push origin HEAD", cwd: launch.root } });
		expect((await deliver())[0]).toMatchObject({ block: true });
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd: launch.root } });
		const outcome = await run();
		expect(outcome.isError, outcome.text).toBeUndefined();
		const log = JSON.parse(readFileSync(join(launch.root, "patch-log.json"), "utf8"));
		expect(log.patch).toBe(expected.text); expect(log.mode).toBe(0o600);
		expect(log.prompt).toContain("Read this artifact in full"); expect(log.prompt).toContain("- frozen.json");
		expect(log.prompt).not.toContain('+    "i": 11999,');
		expect(Buffer.byteLength(log.prompt)).toBeLessThan(256 * 1024);
		expect(existsSync(log.path)).toBe(false);
		expect(outcome.results[0].reviewFingerprint).toBe(reviewFingerprint(expected));
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: false, details: { results: outcome.results } });
		expect(pi.entries).toHaveLength(1); expect((await deliver())[0]).toBeUndefined();
		writeFileSync(join(launch.root, "frozen.json"), frozen.replace('"i": 11999', '"i": 99999')); git("add", "frozen.json"); git("commit", "-m", "later edit");
		expect((await deliver())[0]).toMatchObject({ block: true, reason: expect.stringContaining("stale") });
	});
	it("transports an oversized minified JSON line losslessly in readable chunks", async () => {
		writeFileSync(join(launch.root, "frozen.json"), JSON.stringify(JSON.parse(frozen))); git("add", "frozen.json"); git("commit", "-m", "minify fixture");
		artifactWorker(); const expected = captureDeliveryDiff(launch.root)!;
		const outcome = await run();
		expect(outcome.isError, outcome.text).toBeUndefined();
		const log = JSON.parse(readFileSync(join(launch.root, "patch-log.json"), "utf8"));
		expect(JSON.parse(log.patch).join("")).toBe(expected.text);
		expect(log.prompt).toContain("JSON array of string chunks");
		expect(outcome.results[0].reviewFingerprint).toBe(reviewFingerprint(expected));
	});
	it.each(["success", "no-output", "nonzero", "aborted", "mutated", "missing-session", "no-progress", "signal"])("resumes an incomplete large review with fail-closed outcome %s", async mode => {
		writeFileSync(launch.piBin, `#!${process.execPath}
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
const mode = ${JSON.stringify(mode)};
const callsPath = ${JSON.stringify(join(launch.root, "patch-log.json"))};
const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, "utf8")) : [];
const argv = process.argv.slice(2), option = key => argv[argv.indexOf(key) + 1];
const sessionDir = argv.includes("--session-dir") ? option("--session-dir") : undefined;
const sessionId = argv.includes("--session-id") ? option("--session-id") : undefined;
const patchPath = calls[0]?.patchPath ?? prompt.match(/Complete captured patch: (.+) \\(\\d+ bytes,/)[1];
const patch = fs.readFileSync(patchPath, "utf8");
(async () => {
 const {createReadToolDefinition} = await import(${JSON.stringify(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js"))});
 const {SessionManager} = await import(${JSON.stringify(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js"))});
 let session, prior = "";
 if(sessionDir && sessionId) {
  const existing = SessionManager.findById(${JSON.stringify(launch.root)}, sessionId, sessionDir);
  if(calls.length && !existing) throw Error("lost reviewer session");
  session = existing ? SessionManager.open(existing, sessionDir) : SessionManager.create(${JSON.stringify(launch.root)}, sessionDir, {id:sessionId});
  prior = JSON.stringify(session.buildSessionContext().messages);
 }
 const read = createReadToolDefinition(${JSON.stringify(launch.root)});
 let offset = calls.length && mode !== "no-progress" ? calls[0].next : 1;
 for(; offset <= patch.split("\\n").length;) {
  const args = {path:patchPath, offset, limit:1500}, toolCallId = "read-" + offset;
  console.log(JSON.stringify({type:"tool_execution_start",toolName:"read",toolCallId,args}));
  const result = await read.execute(toolCallId, args);
  console.log(JSON.stringify({type:"tool_execution_end",toolName:"read",toolCallId,result,isError:false}));
  offset += result.details?.truncation?.outputLines ?? Math.min(1500, patch.split("\\n").length-offset+1);
  if(!calls.length || mode === "no-progress") break;
 }
 const finding = "code0.ts may expose an unsafe value";
 if(calls.length && !prior.includes(finding)) throw Error("prior finding lost");
 const text = calls.length ? "Complete cumulative review: " + finding + "; remainder reviewed." : "DELIVERY_REVIEW_INCOMPLETE: more patch remains; " + finding;
 const message = {role:"assistant",content:[{type:"text",text}],stopReason:"stop",timestamp:Date.now()};
 if(calls.length && mode === "aborted") message.stopReason = "aborted";
 if(!(calls.length && mode === "no-output")) session?.appendMessage(message);
 if(mode === "missing-session" && sessionDir) fs.rmSync(sessionDir,{recursive:true,force:true});
 if(mode === "mutated") fs.appendFileSync(${JSON.stringify(join(launch.root,"code0.ts"))}, "export const mutation = true;\\n");
 calls.push({argv,prompt,patchPath,sessionDir,sessionId,prior,next:offset,pid:process.pid}); fs.writeFileSync(callsPath,JSON.stringify(calls));
 if(calls.length === 2 && mode === "signal") { setInterval(() => {}, 1000); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"ABORT_READY"}],stopReason:"stop"}})); return; }
 if(!(calls.length === 2 && mode === "no-output")) console.log(JSON.stringify({type:"message_end",message}));
 if(calls.length === 2 && mode === "nonzero") process.exitCode = 1;
})().catch(error => { console.error(error); process.exit(1); });
`);
		const expected = captureDeliveryDiff(launch.root)!;
		if (mode === "signal") {
			const controller = new AbortController();
			const controlled = host(); controlled.signal = controller.signal;
			controlled.reportUpdate = update => {
				if (update.content.some(block => block.type === "text" && block.text === "ABORT_READY")) controller.abort();
			};
			await expect(runSingleDelegation({ agent: "code-reviewer", task: "Review the change", model: "zai/glm-low" }, "off", controlled)).rejects.toMatchObject({ name: "DelegationAborted" });
			const calls = JSON.parse(readFileSync(join(launch.root, "patch-log.json"), "utf8"));
			expect(calls).toHaveLength(2);
			expect(() => process.kill(calls[1].pid, 0)).toThrow();
			expect(existsSync(calls[0].patchPath)).toBe(false); expect(existsSync(calls[0].sessionDir)).toBe(false);
			return;
		}
		const outcome = await run();
		expect(existsSync(join(launch.root, "patch-log.json")), outcome.text).toBe(true);
		const calls = JSON.parse(readFileSync(join(launch.root, "patch-log.json"), "utf8"));
		expect(calls).toHaveLength(["mutated", "missing-session"].includes(mode) ? 1 : 2);
		expect(calls[0].sessionDir).toBeTruthy(); expect(calls[0].sessionId).toBeTruthy();
		if (calls.length === 2) {
			expect(calls[1].sessionDir).toBe(calls[0].sessionDir); expect(calls[1].sessionId).toBe(calls[0].sessionId);
			expect(calls[1].prior).toContain("code0.ts may expose an unsafe value");
		}
		if (mode === "success") {
			expect(outcome.text).toContain("Complete cumulative review: code0.ts may expose an unsafe value");
			expect(outcome.isError, outcome.text).toBeUndefined();
			expect(outcome.results[0].reviewFingerprint).toBe(reviewFingerprint(expected));
		} else {
			expect(outcome.isError, outcome.text).toBe(true);
			expect(outcome.results[0].reviewFingerprint).toBeUndefined();
		}
		expect(existsSync(calls[0].patchPath)).toBe(false); expect(existsSync(calls[0].sessionDir)).toBe(false);
	});
	it.each(["none", "first"])("does not stamp a successful worker with %s artifact read coverage", async pages => {
		artifactWorker("Complete review; no findings.", 0, pages);
		const outcome = await run();
		expect(outcome.isError).toBe(true); expect(outcome.results[0].reviewFingerprint).toBeUndefined();
		expect(outcome.text).toContain("Delivery review incomplete");
	});
	it.each(["@", "file"])("accepts complete artifact reads through native path alias %s", async prefix => {
		artifactWorker("Complete review; no findings.", 0, "all", false, prefix);
		const expected = reviewFingerprint(captureDeliveryDiff(launch.root)!);
		const outcome = await run();
		expect(outcome.isError, outcome.text).toBeUndefined(); expect(outcome.results[0].reviewFingerprint).toBe(expected);
	});
	it("verifies artifact pages with Unicode split between stdout buffers", async () => {
		writeFileSync(join(launch.root, "frozen.json"), frozen.replaceAll("frozen", "évidence")); git("add", "frozen.json"); git("commit", "-m", "Unicode fixture");
		artifactWorker("Complete review; no findings.", 0, "all", true);
		const expected = reviewFingerprint(captureDeliveryDiff(launch.root)!);
		const outcome = await run();
		expect(outcome.isError, outcome.text).toBeUndefined(); expect(outcome.results[0].reviewFingerprint).toBe(expected);
		const log = JSON.parse(readFileSync(join(launch.root, "patch-log.json"), "utf8")); expect(log.splitWrites).toBeGreaterThan(0);
	});
	it.each([
		["DELIVERY_REVIEW_INCOMPLETE: unable to complete review.", true],
		["No findings. The `DELIVERY_REVIEW_INCOMPLETE` marker is correctly handled.", false],
		["No findings. Protocol example:\n```text\nDELIVERY_REVIEW_INCOMPLETE: example\n```", false],
		["No findings. Nested example:\n````text\n```text\nDELIVERY_REVIEW_INCOMPLETE: example\n```\n````", false],
		["No findings. Protocol example:\n~~~text\nDELIVERY_REVIEW_INCOMPLETE: example\n~~~", false],
		["No findings. Protocol example:\n    DELIVERY_REVIEW_INCOMPLETE: example", false],
		["```text\nDELIVERY_REVIEW_INCOMPLETE: unavailable evidence\n```", true],
		["```text\nDELIVERY_REVIEW_INCOMPLETE: unavailable evidence", true],
		["    DELIVERY_REVIEW_INCOMPLETE: unavailable evidence", true],
	])("handles explicit inline refusal without treating quoted marker mentions as refusal: %s", async (text, incomplete) => {
		git("rm", "frozen.json"); git("commit", "-m", "small inline fixture");
		launch.setReplies([{ match: "Review the change", text: String(text) }]);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd: launch.root } });
		const outcome = await run();
		expect(outcome.isError).toBe(incomplete ? true : undefined);
		if (incomplete) expect(outcome.results[0].reviewFingerprint).toBeUndefined();
		else expect(outcome.results[0].reviewFingerprint).toBe(reviewFingerprint(captureDeliveryDiff(launch.root)!));
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: !!outcome.isError, details: { results: outcome.results } });
		expect(pi.entries).toHaveLength(incomplete ? 0 : 1);
	});
	it("rejects an inline refusal in a later assistant text block", async () => {
		git("rm", "frozen.json"); git("commit", "-m", "small inline fixture");
		const message = { role: "assistant", stopReason: "stop", content: [
			{ type: "text", text: "Findings for the files examined." },
			{ type: "text", text: "DELIVERY_REVIEW_INCOMPLETE: remaining files not reviewed." },
		] };
		writeFileSync(launch.piBin, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on("end", () => console.log(${JSON.stringify(JSON.stringify({ type: "message_end", message }))}));\n`);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd: launch.root } });
		const outcome = await run();
		expect(outcome.isError).toBe(true); expect(outcome.results[0].reviewFingerprint).toBeUndefined();
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: !!outcome.isError, details: { results: outcome.results } });
		expect(pi.entries).toHaveLength(0);
	});
	it("preserves the primary worker failure rather than masking it as incomplete coverage", async () => {
		artifactWorker("Primary worker failure", 3, "none"); const outcome = await run();
		expect(outcome.isError).toBe(true); expect(outcome.results[0].reviewFingerprint).toBeUndefined();
		expect(outcome.text).toContain("Primary worker failure"); expect(outcome.text).not.toContain("Delivery review incomplete");
	});
	it("removes a partially written artifact if its creation fails", async () => {
		const originalWrite = promises.writeFile.bind(promises);
		let failedDir = "";
		vi.spyOn(promises, "writeFile").mockImplementation(async (path, data, options) => {
			await originalWrite(path, data, options);
			if (String(path).endsWith("prompt-review-diff.md")) {
				failedDir = dirname(String(path)); throw new Error("ENOSPC: artifact write failed");
			}
		});
		await expect(run()).rejects.toThrow("ENOSPC");
		expect(failedDir).not.toBe(""); expect(existsSync(failedDir)).toBe(false);
	});
	it.each([0, 3])("cleans artifacts and cannot stamp incomplete/failed worker output (exit %s)", async exit => {
		artifactWorker("DELIVERY_REVIEW_INCOMPLETE: unable to complete review.", exit);
		const pi = createFakePi(); registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "r", input: { agent: "code-reviewer", cwd: launch.root } });
		const outcome = await run();
		const log = JSON.parse(readFileSync(join(launch.root, "patch-log.json"), "utf8"));
		expect(existsSync(log.path)).toBe(false); expect(outcome.results[0].reviewFingerprint).toBeUndefined();
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "r", input: {}, isError: exit !== 0, details: { results: outcome.results } });
		expect(pi.entries).toHaveLength(0);
	});
});
