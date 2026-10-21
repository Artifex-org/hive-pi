import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReviewContinuation } from "../extensions/subagent/review-continuation.ts";
import { ReviewArtifactReads } from "../extensions/subagent/review-artifact.ts";
import { captureDeliveryDiff, reviewFingerprint } from "../extensions/subagent/reviewdiff.ts";
import { testTempEnv } from "./temp-env.ts";
import { buildSubagentWorkerArgs } from "../extensions/subagent/worker.ts";

it.each(["ordinary", "format-correction"] as const)("the actual CLI resumes the configured private reviewer conversation (%s)", async mode => {
	const root = mkdtempSync(join(tmpdir(), "review-cli-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
	writeFileSync(join(root, ".git", "info", "exclude"), "*\n!change.ts\n");
	writeFileSync(join(root, "change.ts"), "export const value = 1;\n"); git("add", "change.ts"); git("commit", "-m", "base");
	git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
	writeFileSync(join(root, "change.ts"), "export const value = 2;\n");
	const diff = captureDeliveryDiff(root)!;
	const patch = join(root, "patch"); writeFileSync(patch, diff.text);
	const reads = new ReviewArtifactReads(patch, diff.text, root);
	const continuation = new ReviewContinuation(root, "review", reviewFingerprint(diff), reads);
	const requests: { messages: { role: string; content: unknown }[] }[] = [];
	const finding = "Prior review finding: unsafe boundary in code0.ts";
	const first = "DELIVERY_REVIEW_INCOMPLETE: " + finding + "\nREVIEW_LEDGER " + JSON.stringify({ complete: false, findings: [{ id: null, status: "new", location: "code0.ts:1", issue: finding, scenario: "An unchecked input crosses the boundary.", evidence: "The caller forwards the unchecked input." }] });
	const integration = "DELIVERY_REVIEW_INCOMPLETE: caller traced; regression coverage pending\nREVIEW_LEDGER " + JSON.stringify({ complete: false, findings: [{ id: "F1", status: "upheld", location: "code0.ts:1", evidence: "The caller still forwards the unchecked input." }] });
	const final = "Complete cumulative review: " + finding + "\nREVIEW_LEDGER " + JSON.stringify({ complete: true, findings: [{ id: "F1", status: "upheld", location: "code0.ts:1", evidence: "The caller still forwards the unchecked input." }] });
	const rejected = first.split("\n").map(line => line.startsWith("REVIEW_LEDGER ") ? `\`${line}\`` : line).join("\n");
	const replies = mode === "format-correction" ? [rejected, first, integration, final] : [first, integration, final];
	const server = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		requests.push(JSON.parse(body));
		const text = replies[requests.length - 1] ?? "Unexpected extra fixture request";
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "review", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
		res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "review", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	try {
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server address");
		writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "dummy-local-only", models: [{ id: "review", contextWindow: 100000, maxTokens: 1024 }] } } }));
		const args = buildSubagentWorkerArgs("fixture/review", ["read"]); continuation.configure(args);
		const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
		const run = (prompt: string) => new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...testTempEnv(), PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "", stderr = "";
			const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI fixture timed out")); }, 60000);
			child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
			child.on("error", error => { clearTimeout(timer); reject(error); });
			child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`CLI exit ${code}: ${stderr}`)); });
			child.stdin.end(prompt);
		});
		expect(await run("Review the supplied evidence.")).toContain("DELIVERY_REVIEW_INCOMPLETE");
		// Inject complete observed coverage; this fixture tests REAL CLI
		// persistence and reconciliation, not a real model's semantic competence.
		reads.observe({ type: "tool_execution_start", toolName: "read", toolCallId: "page", args: { path: patch, offset: 1, limit: diff.text.split("\n").length } });
		reads.observe({ type: "tool_execution_end", toolName: "read", toolCallId: "page", result: { content: [{ type: "text", text: diff.text }] } });
		expect(reads.complete()).toBe(true);
		let next = continuation.next([{ role: "assistant", content: [{ type: "text", text: replies[0] }], stopReason: "stop" }], true);
		expect(next.error).toBeUndefined(); expect(next.prompt).toContain("SAME delivery review");
		if (mode === "format-correction") {
			expect(next.prompt).toContain("format correction 1/2"); expect(next.findings).toBeUndefined();
			expect(await run(next.prompt!)).toContain(JSON.stringify(first));
			next = continuation.next([{ role: "assistant", content: [{ type: "text", text: first }], stopReason: "stop" }], true);
			expect(next.error).toBeUndefined(); expect(next.findings).toBeUndefined();
			expect(next.prompt).toContain("Semantic integration continuation 1/8");
		}
		expect(await run(next.prompt!)).toContain("regression coverage pending");
		const last = continuation.next([{ role: "assistant", content: [{ type: "text", text: integration }], stopReason: "stop" }], true);
		expect(last.error).toBeUndefined(); expect(last.findings).toBeUndefined();
		expect(last.prompt).toContain("Semantic integration continuation 2/8");
		expect(await run(last.prompt!)).toContain("Complete cumulative review");
		const completed = continuation.next([{ role: "assistant", content: [{ type: "text", text: final }], stopReason: "stop" }], true);
		expect(completed.error).toBeUndefined(); expect(completed.prompt).toBeUndefined();
		expect(JSON.parse(completed.findings!)).toHaveLength(1); expect(completed.findings).toContain(finding);
		expect(requests).toHaveLength(mode === "format-correction" ? 4 : 3);
		expect(requests.at(-1)!.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(finding))).toBe(true);
		expect(requests.at(-1)!.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("regression coverage pending"))).toBe(true);
		if (mode === "format-correction") {
			expect(requests[1].messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("`REVIEW_LEDGER"))).toBe(true);
			expect(requests[1].messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("format correction 1/2"))).toBe(true);
		}
	} finally {
		server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
		continuation.cleanup(); expect(existsSync(continuation.dir)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	}
}, 125000);
