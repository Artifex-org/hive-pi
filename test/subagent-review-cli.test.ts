import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReviewContinuation } from "../extensions/subagent/review-continuation.ts";
import { ReviewArtifactReads } from "../extensions/subagent/review-artifact.ts";
import { captureDeliveryDiff, reviewFingerprint } from "../extensions/subagent/reviewdiff.ts";
import { buildSubagentWorkerArgs } from "../extensions/subagent/worker.ts";

it("the actual CLI resumes the configured private reviewer conversation", async () => {
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
	const server = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		requests.push(JSON.parse(body));
		const text = requests.length === 1 ? "DELIVERY_REVIEW_INCOMPLETE: " + finding : "Complete cumulative review: " + finding;
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
			const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "", stderr = "";
			const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI fixture timed out")); }, 60000);
			child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
			child.on("error", error => { clearTimeout(timer); reject(error); });
			child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`CLI exit ${code}: ${stderr}`)); });
			child.stdin.end(prompt);
		});
		expect(await run("Review the supplied evidence.")).toContain("DELIVERY_REVIEW_INCOMPLETE");
		// Observe a completed read page before asking production to resume the
		// transcript that the REAL CLI serialized, not a fixture-authored log.
		reads.observe({ type: "tool_execution_start", toolName: "read", toolCallId: "page", args: { path: patch, offset: 1, limit: 1 } });
		reads.observe({ type: "tool_execution_end", toolName: "read", toolCallId: "page", result: { content: [{ type: "text", text: diff.text.split("\n")[0] }] } });
		const next = continuation.next("DELIVERY_REVIEW_INCOMPLETE: " + finding, true);
		expect(next.error).toBeUndefined(); expect(next.prompt).toContain("SAME delivery review");
		expect(await run(next.prompt!)).toContain("Complete cumulative review");
		expect(requests).toHaveLength(2);
		expect(requests[1].messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(finding))).toBe(true);
	} finally {
		server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
		continuation.cleanup(); expect(existsSync(continuation.dir)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	}
}, 125000);
