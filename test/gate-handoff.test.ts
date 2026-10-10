import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runToolCall, type AgentTool } from "@earendil-works/pi-agent-core";
import gate from "../extensions/gate/index.ts";
import background from "../extensions/background/index.ts";
import * as claudeState from "../claude/state.ts";
import { runGateTool } from "../claude/mcp/gate-tool.ts";
import type { HiveTask } from "../extensions/gate/hivecheck.ts";
import { createFakePi } from "./fake-pi.ts";

const REF = { id: "8ee772a4-90e2-4b5b-9995-66569a3b6b29", number: 3509 };
const api = vi.hoisted(() => ({ request: vi.fn(), dispatch: vi.fn() }));
vi.mock("../extensions/hive-common/http.ts", async (original) => ({ ...await original<object>(), request: api.request }));
vi.mock("../extensions/gate/hiverun.ts", async (original) => ({
	...await original<object>(), dispatch: api.dispatch, hivePipelineDir: async () => "/repo/.hive",
}));

let dir: string;
let tasks: HiveTask[];
let state: string;
let shutdown: (() => Promise<unknown>) | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gate-handoff-"));
	vi.stubEnv("HIVE_URL", "https://hive.example"); vi.stubEnv("HIVE_TOKEN", "t");
	vi.stubEnv("HIVE_TELEMETRY_URL", "https://hive.example"); vi.stubEnv("HIVE_TELEMETRY_TOKEN", "t");
	vi.stubEnv("HIVE_LAUNCH_ID", "");
	state = "running"; tasks = [{ key: "test", state: "running" }];
	api.dispatch.mockReset().mockResolvedValue({ ref: REF, out: "", code: 0, signal: null });
	api.request.mockReset().mockImplementation(async (_auth, _method, path) => ({
		ok: true, body: path.endsWith("substeps") ? { substeps: [] } : { run: { state }, tasks },
	}));
});
afterEach(async () => {
	vi.useRealTimers(); await shutdown?.(); shutdown = undefined;
	vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
});

/** Execute the registered gate with its real nested watcher from the same registry. */
async function start(options: { abort?: AbortSignal; watchError?: boolean; keepHive?: boolean } = {}) {
	if (!options.keepHive) { writeFileSync(join(dir, "hive"), "#!/bin/sh\necho 'run verdict: PASSED'\nexit 0\n"); chmodSync(join(dir, "hive"), 0o755); }
	vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
	const pi = createFakePi(); background(pi.api); gate(pi.api);
	await pi.emit({ type: "session_start" }, { mode: "tui", cwd: dir });
	shutdown = () => pi.emit({ type: "session_shutdown" });
	const getTool = (name: string) => pi.tools.find((t) => t.name === name)!.definition.execute as (...args: any[]) => Promise<any>;
	let firstSnapshot!: () => void;
	const observed = new Promise<void>((r) => { firstSnapshot = r; });
	const executeTool = vi.fn(async (name, args, nestedOptions?: { signal?: AbortSignal }) => {
		// Run argument validation, abort handling and execution through pi's real
		// nested-call pipeline, including inherited parent signals.
		vi.useRealTimers();
		const definition = pi.tools.find((t) => t.name === name)!.definition;
		const tool = { ...definition, execute: (id: string, input: unknown, signal?: AbortSignal) =>
			getTool(name)(id, input, signal, undefined, { mode: "tui", cwd: dir }) } as AgentTool;
		return runToolCall({ type: "toolCall", id: "nested", name, arguments: args }, {
			tools: [tool], signal: nestedOptions?.signal ?? options.abort,
			beforeToolCall: options.watchError ? async () => ({ block: true, reason: "watcher unavailable" }) : undefined,
			context: { messages: [], tools: [tool] },
			assistantMessage: { role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse", timestamp: 0 },
		});
	});
	vi.useFakeTimers();
	const result = getTool("quality_gate")("gate", { only: "lint,test" }, options.abort, firstSnapshot,
		{ cwd: dir, executeTool });
	await observed;
	return { pi, result, executeTool };
}

async function verdict(pi: ReturnType<typeof createFakePi>) {
	const deadline = Date.now() + 5000;
	while (!pi.messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	expect(pi.messages).toHaveLength(1);
	expect(pi.messages[0].details).toMatchObject({ status: "done" });
	expect(pi.messages[0].content).toContain("run verdict: PASSED");
	await new Promise((r) => setTimeout(r, 100));
	expect(pi.messages).toHaveLength(1);
}

describe("quality_gate foreground handoff", () => {
	it("returns an explicit Claude watcher call without creating an unannounceable job", async () => {
		vi.useFakeTimers();
		const result = runGateTool({ only: "test" }, dir, new AbortController().signal);
		await vi.waitFor(() => expect(api.request).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(120_000);
		const output = await result;
		expect(output.text).toContain(REF.id);
		expect(output.text).toContain("requires a separate hive_watch_run call");
		expect(output.text).toContain("No background watch was started");
		expect(output.text).not.toContain("hive-pi-job:");
		expect(api.request.mock.calls.some((args) => String(args[2]).endsWith("/cancel"))).toBe(false);
	});

	it("retains the run reference in the response when Claude recovery storage fails", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(claudeState, "writeJsonAtomic").mockImplementation(() => { throw new Error("ENOSPC"); });
		try {
			const result = runGateTool({ only: "test" }, dir, new AbortController().signal, dir);
			await vi.waitFor(() => expect(api.request).toHaveBeenCalled());
			await vi.advanceTimersByTimeAsync(120_000);
			const output = await result;
			expect(output.isError).toBe(true); expect(output.text).toContain(REF.id);
			expect(output.text).toContain("NOT cancelled"); expect(output.text).toContain("Could not retain the gate report");
			expect(output.text).toContain("ENOSPC");
		} finally { write.mockRestore(); }
	});
	it("returns at the bound, never cancels running work, and sends exactly one verdict wake", async () => {
		const s = await start();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(s.executeTool).toHaveBeenCalledTimes(1); // independent 120s acceptance bound
		const out = await s.result;
		expect(out.content[0].text).toContain(REF.id);
		expect(out.content[0].text).toContain("NOT cancelled");
		expect(s.executeTool).toHaveBeenCalledExactlyOnceWith("hive_watch_run", {
			run: REF.id, what: "waiting for the quality gate verdict", timeout_seconds: 14_400,
		}, { signal: expect.any(AbortSignal) });
		expect(api.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
		await verdict(s.pi);
	});
	it("uses the queued bound when lint finished but test is awaiting its template", async () => {
		tasks = [{ key: "lint", state: "succeeded" }, { key: "test", state: "ready", defer_reason: "awaiting_template" }];
		const s = await start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.executeTool).toHaveBeenCalledTimes(1); // independent 60s queued bound
		expect((await s.result).content[0].text).toContain("all unfinished tasks are waiting for admission");
		expect(s.executeTool).toHaveBeenCalledTimes(1);
		await verdict(s.pi);
	});
	it("hands off an explicitly queued run with no materialised tasks at 60 seconds", async () => {
		state = "queued"; tasks = [];
		const s = await start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.executeTool).toHaveBeenCalledTimes(1);
		expect((await s.result).content[0].text).toContain("all unfinished tasks are waiting for admission");
		await verdict(s.pi);
	});
	it("keeps a quick lint verdict synchronous, with no watch or wake", async () => {
		tasks = [{ key: "lint", state: "running" }];
		const s = await start(); state = "succeeded"; tasks = [{ key: "lint", state: "succeeded" }];
		await vi.advanceTimersByTimeAsync(2000);
		expect((await s.result).content[0].text).toContain("PASS");
		expect(s.executeTool).not.toHaveBeenCalled(); expect(s.pi.messages).toHaveLength(0);
	});
	it("hands off at the first failed test shard with its log, never cancelling the shards still running", async () => {
		tasks = [{ key: "test-1", state: "failed", id: "t1" }, { key: "test-2", state: "queued" }, { key: "lint", state: "running" }];
		vi.stubGlobal("fetch", vi.fn(async () => new Response("collected 12 items\nAssertionError: parser lost a token\n", { status: 200 })));
		try {
			const s = await start();
			const out = await s.result;
			const text = out.content[0].text;
			expect(text).toContain("TASK FAILED — `test-1` failed while other tasks are still running");
			expect(text).toContain("AssertionError: parser lost a token");
			expect(text).toContain("NOT cancelled");
			// A failed task is not a failed run: the widget never shows a verdict early.
			expect(out.details).toMatchObject({ hive_widget: { spec: { status: "nosummary" } } });
			expect(s.executeTool).toHaveBeenCalledExactlyOnceWith("hive_watch_run", {
				run: REF.id, what: "waiting for the quality gate verdict", timeout_seconds: 14_400,
			}, { signal: expect.any(AbortSignal) });
			expect(api.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
			await verdict(s.pi);
		} finally { vi.unstubAllGlobals(); }
	});
	it("does not re-announce any failure it returned when the watch replays them", async () => {
		tasks = [{ key: "test-1", state: "failed", id: "t1" }, { key: "test-3", state: "failed", id: "t3" },
			{ key: "lint", state: "failed", spec: { allow_failure: true } }, { key: "test-2", state: "running" }];
		writeFileSync(join(dir, "hive"), `#!/bin/sh\nprintf '%s\\n' 'task.failed            lint' 'task.failed            test-1: exit 1' 'task.failed            test-3'\nsleep 3\necho 'run verdict: PASSED'\nexit 0\n`);
		chmodSync(join(dir, "hive"), 0o755);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("boom\n", { status: 200 })));
		try {
			const s = await start({ keepHive: true });
			expect((await s.result).content[0].text).toContain("TASK FAILED");
			await verdict(s.pi);
		} finally { vi.unstubAllGlobals(); }
	});
	it("on an abort, leaves the failure for the watch to announce, since the result does not show it", async () => {
		tasks = [{ key: "test-1", state: "failed", id: "t1" }, { key: "test-2", state: "running" }];
		writeFileSync(join(dir, "hive"), `#!/bin/sh\nprintf '%s\\n' 'task.failed            test-1: exit 1'\nsleep 3\necho 'run verdict: PASSED'\nexit 0\n`);
		chmodSync(join(dir, "hive"), 0o755);
		const controller = new AbortController(); controller.abort();
		const s = await start({ abort: controller.signal, keepHive: true });
		const text = (await s.result).content[0].text;
		expect(text).toContain("call was aborted"); expect(text).not.toContain("TASK FAILED");
		const deadline = Date.now() + 10_000;
		while (s.pi.messages.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		expect(s.pi.messages.map((m) => m.customType)).toEqual(["background-progress", "background"]);
		expect(s.pi.messages[0].details).toMatchObject({ task: "test-1" });
	});
	it("does not hand off early for an allow_failure step or one its on_failure fixer will repair", async () => {
		tasks = [{ key: "lint", state: "failed", spec: { allow_failure: true } }, { key: "test-1", state: "failed", spec: { on_failure: "fix-test-1" } },
			{ key: "test-2", state: "running" }];
		const s = await start(); state = "succeeded"; tasks = tasks.map((t) => t.key === "test-2" ? { ...t, state: "succeeded" } : t);
		await vi.advanceTimersByTimeAsync(2000);
		expect((await s.result).content[0].text).not.toContain("TASK FAILED");
		expect(s.executeTool).not.toHaveBeenCalled();
	});
	it("keeps following when the failed shard was the last one, so the verdict stays synchronous", async () => {
		tasks = [{ key: "lint", state: "succeeded" }, { key: "test", state: "failed" }];
		const s = await start(); state = "failed";
		await vi.advanceTimersByTimeAsync(2000);
		expect((await s.result).content[0].text).toContain("FAIL");
		expect(s.executeTool).not.toHaveBeenCalled(); expect(s.pi.messages).toHaveLength(0);
	});
	it("does not cancel on abort either", async () => {
		const controller = new AbortController(); const s = await start({ abort: controller.signal });
		controller.abort();
		expect((await s.result).content[0].text).toContain("call was aborted");
		expect(api.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
		await verdict(s.pi);
	});
	it("reports a refused watcher explicitly rather than promising a wake", async () => {
		const s = await start({ watchError: true }); await vi.advanceTimersByTimeAsync(120_000);
		const out = (await s.result).content[0].text;
		expect(out).toContain("watcher unavailable"); expect(out).toContain("No background watch was started");
		expect(s.pi.messages).toHaveLength(0);
	});
});
