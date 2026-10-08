import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DelegationAborted, getFinalOutput, isFailedResult, runSingleAgent } from "../extensions/subagent/delegate.ts";
import type { AgentConfig } from "../extensions/harness/roles-core.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(mode: string) {
	const root = await mkdtemp(join(tmpdir(), "pi-native-worker-replay-")); roots.push(root);
	const agentDir = join(root, "agent"); await mkdir(agentDir);
	await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
	await writeFile(join(root, "evidence.txt"), "native-tool-evidence");
	const launcher = join(root, "native-fixture.js");
	const fixture = fileURLToPath(new URL("./fixtures/native-worker-replay.ts", import.meta.url));
	await writeFile(launcher, `await import(${JSON.stringify(fixture)});\n`);
	vi.stubEnv("PI_HOUSE_PI_BIN", launcher); vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("NATIVE_WORKER_FIXTURE_MODE", mode);
	const agents: AgentConfig[] = [{ name: "research", description: "offline native fixture", tools: ["read"], systemPrompt: "", source: "package", filePath: "" }];
	return { root, agents };
}
const modelEnv = { isConfigured: () => true, catalog: async () => [] };
const details = (results: Parameters<Parameters<typeof runSingleAgent>[8]>[0]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });
function run(root: string, agents: AgentConfig[], signal?: AbortSignal, onUpdate?: Parameters<typeof runSingleAgent>[7]) {
	return runSingleAgent(root, agents, "research", "offline task", root, undefined, signal, onUpdate, details, undefined, "native-worker-fixture/native-worker-fixture", modelEnv);
}
function summary(stderr: string) {
	const line = stderr.split("\n").find((line) => line.startsWith("fixture_summary "));
	if (!line) throw new Error(`Missing fixture summary: ${stderr}`);
	return JSON.parse(line.slice("fixture_summary ".length));
}
async function assertReaped(root: string) {
	const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
	expect(pid).toBeGreaterThan(0);
	expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

describe("native spawned-worker replay", () => {
	it("folds split native JSON output, executes the granted read, and bills assistants only", async () => {
		const { root, agents } = await setup("success"); const result = await run(root, agents);
		expect(isFailedResult(result)).toBe(false); expect(result.stopReason).toBe("stop"); expect(result.model).toBe("native-worker-fixture");
		expect(result.usage.turns).toBe(2);
		expect(result.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Task: offline task"))).toBe(true);
		expect(result.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(JSON.stringify(result.messages)).toContain("native-tool-evidence");
		expect(getFinalOutput(result.messages)).toBe("Offline native worker read the evidence.");
		const assistantUsage = result.messages.filter((message) => message.role === "assistant").map((message) => message.usage);
		expect(result.usage.input).toBe(assistantUsage.reduce((sum, usage) => sum + usage.input, 0));
		expect(result.usage.output).toBe(assistantUsage.reduce((sum, usage) => sum + usage.output, 0));
		expect(result.usage.input).toBeGreaterThan(0); expect(result.usage.output).toBeGreaterThan(0); expect(result.usage.cost).toBe(0);
		expect(summary(result.stderr)).toMatchObject({ calls: 2, networkCalls: 0, activeTools: ["read"] });
		await assertReaped(root);
	}, 20_000);
	it("records real native retry/backoff and a successful second provider call", async () => {
		const { root, agents } = await setup("retry"); const result = await run(root, agents);
		expect(isFailedResult(result)).toBe(false); expect(getFinalOutput(result.messages)).toBe("Recovered after native retry.");
		expect(result.retries).toEqual({ attempts: 1, maxAttempts: 2, waitedMs: 5, succeeded: true });
		expect(summary(result.stderr)).toMatchObject({ calls: 2, networkCalls: 0 });
		await assertReaped(root);
	}, 20_000);
	it("recognizes exhausted native retries as failure even when JSON-mode exits zero", async () => {
		const { root, agents } = await setup("exhausted"); const result = await run(root, agents);
		expect(result.exitCode).toBe(0); expect(isFailedResult(result)).toBe(true); expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("429");
		expect(result.retries).toEqual({ attempts: 2, maxAttempts: 2, waitedMs: 15, succeeded: false });
		expect(summary(result.stderr)).toMatchObject({ calls: 3, networkCalls: 0 });
		await assertReaped(root);
	}, 20_000);
	it("aborts after native tool evidence while the next response streams and reaps the child", async () => {
		const { root, agents } = await setup("cancel"); const controller = new AbortController();
		let cancelledWhileWriting = false;
		const guard = setTimeout(() => controller.abort(), 10_000);
		try {
			await run(root, agents, controller.signal, (update) => {
				const result = update.details?.results[0];
				if (result?.usage.turns === 1 && result.activity === "writing response") { cancelledWhileWriting = true; controller.abort(); }
			});
			throw new Error("Cancellation unexpectedly returned success");
		} catch (error) {
			expect(cancelledWhileWriting).toBe(true);
			expect(error).toBeInstanceOf(DelegationAborted);
			if (!(error instanceof DelegationAborted)) throw error;
			expect(error.result.usage.turns).toBeGreaterThanOrEqual(1);
			expect(JSON.stringify(error.result.messages)).toContain("native-tool-evidence");
			expect(getFinalOutput(error.result.messages)).not.toBe("Offline native worker read the evidence.");
			await assertReaped(root);
			expect(JSON.parse(await readFile(join(root, "shutdown.json"), "utf8"))).toEqual({ sigterm: true, calls: 2 });
		} finally { clearTimeout(guard); controller.abort(); }
	}, 20_000);
	it("reports startup failure without producing a user-prompt success", async () => {
		const { root, agents } = await setup("startup-failure"); const result = await run(root, agents);
		expect(isFailedResult(result)).toBe(true); expect(result.stderr).toContain("fixture startup failure");
		expect(result.usage.turns).toBe(0); expect(result.messages).toEqual([]);
		await assertReaped(root);
	}, 20_000);
});
