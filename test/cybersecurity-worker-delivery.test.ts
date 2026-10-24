import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runSingleDelegation, type DelegationHost } from "../extensions/subagent/delegate.ts";
import { registerDeliveryReview } from "../extensions/subagent/delivery.ts";
import { createFakePi } from "./fake-pi.ts";
import * as lifecycle from "../extensions/subagent/lifecycle.ts";

it("a worker's recovered provider error remains in history but does not prevent its delivery-review stamp", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cyber-worker-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const worker = join(cwd, "worker.mjs");
	const events = [
		{ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "fixture", content: [], stopReason: "error", errorMessage: "Request blocked by cybersecurity policy" } },
		{ type: "message_end", message: { role: "assistant", provider: "zai", model: "glm-5.3-flash", content: [{ type: "text", text: "No findings." }], stopReason: "stop" } },
	];
	await writeFile(worker, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event)); });\n`, { mode: 0o755 });
	try {
		git("init", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.com");
		git("add", "."); git("commit", "-m", "fixture"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
		await writeFile(join(cwd, "code.ts"), Array.from({ length: 12 }, (_, n) => `export const value${n} = ${n};`).join("\n") + "\n");
		git("add", "code.ts");
		vi.stubEnv("PI_HOUSE_PI_BIN", worker);
		const pi = createFakePi();
		registerDeliveryReview(pi.api);
		await pi.emit({ type: "tool_call", toolName: "subagent", toolCallId: "review", input: { agent: "code-reviewer", cwd } });
		const host: DelegationHost = {
			cwd, agents: [{ name: "code-reviewer", description: "review", tools: ["read"], systemPrompt: "Review the diff.", source: "package", filePath: "" }],
			modelEnv: { isConfigured: () => true, catalog: async () => [] }, signal: undefined,
			makeDetails: mode => results => ({ mode, agentScope: "user", projectAgentsDir: null, results }),
		};
		const outcome = await runSingleDelegation({ agent: "code-reviewer", task: "Review the diff", model: "openai-codex/fixture" }, "off", host);
		expect(outcome.isError, outcome.text).toBeUndefined();
		expect(outcome.results[0]).toMatchObject({ exitCode: 0, stopReason: "stop" });
		expect(outcome.results[0].errorMessage).toBeUndefined();
		expect(outcome.results[0].messages).toContainEqual(expect.objectContaining({ stopReason: "error", errorMessage: "Request blocked by cybersecurity policy" }));
		await pi.emit({ type: "tool_result", toolName: "subagent", toolCallId: "review", input: {}, isError: false, details: { results: outcome.results } });
		const verdict = await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "git push origin HEAD", cwd } });
		expect(verdict[0]).toBeUndefined(); // a valid review stamp now permits delivery
	} finally {
		vi.unstubAllEnvs();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("late tool results cannot erase the parent's silence-watchdog failure", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cyber-watchdog-"));
	const worker = join(cwd, "worker.mjs");
	await writeFile(worker, `#!/usr/bin/env node
process.stdin.resume();
process.on('SIGTERM', () => {
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'late result' }], toolCallId: 'pending', toolName: 'read' } }));
  setTimeout(() => process.exit(1), 20);
});
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'toolUse' } })));
setInterval(() => {}, 100000);
`, { mode: 0o755 });
	// Trigger the real parent interval after the worker has emitted activity;
	// no ten-minute sleep and no production timeout changes are needed.
	const watchdog = vi.spyOn(lifecycle, "shouldStopForSilence").mockImplementation(seen => seen);
	vi.stubEnv("PI_HOUSE_PI_BIN", worker);
	try {
		const host: DelegationHost = {
			cwd, agents: [{ name: "research", description: "research", tools: ["read"], systemPrompt: "Inspect.", source: "package", filePath: "" }],
			modelEnv: { isConfigured: () => true, catalog: async () => [] }, signal: undefined,
			makeDetails: mode => results => ({ mode, agentScope: "user", projectAgentsDir: null, results }),
		};
		const outcome = await runSingleDelegation({ agent: "research", task: "Inspect the code", model: "openai-codex/fixture" }, "off", host);
		expect(outcome.isError).toBe(true);
		expect(outcome.results[0].stopReason).toBe("error");
		expect(outcome.results[0].errorMessage).toContain("Subagent became inactive");
		expect(outcome.results[0].messages.at(-1)).toMatchObject({ role: "toolResult" });
	} finally {
		watchdog.mockRestore();
		vi.unstubAllEnvs();
		await rm(cwd, { recursive: true, force: true });
	}
}, 10000);
