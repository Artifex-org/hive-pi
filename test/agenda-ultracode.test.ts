/**
 * `/ultracode` and the gating of the `orchestrate` tool.
 *
 * The gate is the point: the plan's own rule is that large orchestration must
 * be REQUESTED, never inferred. Finding 0.1 of the verification pass showed the
 * obvious implementation of that ("register it inactive") does not exist as a
 * concept in pi — every registered extension tool is force-activated at session
 * build and again on `/reload`.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatch } from "../extensions/agenda/plan-graph.ts";
import type { WorkerResult } from "../extensions/agenda/executor.ts";
import type { WorkerHandle, WorkerRegistry } from "../extensions/agenda/rpc-worker.ts";

const runOneShot = vi.hoisted(() => vi.fn());
const runRoleAgent = vi.hoisted(() => vi.fn());
const durableHarness = vi.hoisted(() => ({
	completions: [] as Array<() => void>,
	ids: [] as string[],
	sent: [] as Array<{ id: string; message: string; mode: string }>,
	stopped: [] as string[],
}));
vi.mock("../extensions/agenda/spawn.ts", () => ({
	runOneShot,
	runRoleAgent,
	getPiInvocation: (args: string[]) => ({ command: "pi", args }),
}));
vi.mock("../extensions/agenda/rpc-worker.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../extensions/agenda/rpc-worker.ts")>();
	return {
		...actual,
		makeDurableSpawn: (_cwd: string, runId: string, registry: WorkerRegistry) => async (dispatch: Dispatch) =>
			new Promise<WorkerResult>((resolve) => {
				let alive = true;
				let finished = false;
				const id = `${runId}:${dispatch.nodeId}:${dispatch.workId}`;
				const finish = (result: WorkerResult) => {
					if (finished) return;
					finished = true;
					alive = false;
					registry.remove(id, worker);
					resolve(result);
				};
				const worker: WorkerHandle = {
					id,
					role: dispatch.role,
					cwd: _cwd,
					state: () => ({
						texts: [], tokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
						turns: 1, busy: alive, everSettled: false, lastTool: undefined, reports: [], pendingReplies: [], junk: 0,
					}),
					alive: () => alive,
					send: async (message, mode) => { durableHarness.sent.push({ id, message, mode }); },
					owedTurns: () => 0,
					stderrTail: () => "",
					waitForSettle: async () => {},
					stop: () => {
						durableHarness.stopped.push(id);
						finish({ ok: true, value: { status: "stopped_by_orchestrator", worker_id: id }, tokens: 0 });
					},
				};
				registry.register(worker);
				durableHarness.ids.push(id);
				durableHarness.completions.push(() => finish({ ok: true, value: `result:${id}`, tokens: 42 }));
			}),
	};
});

import agenda from "../extensions/agenda/index.ts";
import { MAX_RESULT_PAGE_CHARS } from "../extensions/agenda/run-output.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

let pi: FakePi;
beforeEach(() => {
	runOneShot.mockReset();
	runRoleAgent.mockReset();
	durableHarness.completions.length = 0;
	durableHarness.ids.length = 0;
	durableHarness.sent.length = 0;
	durableHarness.stopped.length = 0;
	vi.unstubAllEnvs();
	// This suite itself may run inside a Hive-launched agent. Default each test
	// to the human-interactive lane; the Hive-specific case opts in explicitly.
	vi.stubEnv("HIVE_LAUNCH_ID", "");
	pi = createFakePi();
});

describe("orchestrate is gated behind /ultracode", () => {
	it("is stripped from the active set on session_start, despite being registered", async () => {
		agenda(pi.api);
		expect(pi.tools.map((t) => t.name)).toContain("orchestrate");
		// pi force-activates everything it registers…
		expect(pi.activeTools).toContain("orchestrate");

		// …so session_start is where it has to come back out.
		await pi.emit({ type: "session_start", reason: "startup" });
		expect(pi.activeTools).not.toContain("orchestrate");
	});

	it("is available by default in a Hive-launched coding-agent session", async () => {
		vi.stubEnv("HIVE_LAUNCH_ID", "f7ac2065-7b82-44be-a3c1-0cf0f97127b2");
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		expect(pi.activeTools).toEqual(expect.arrayContaining(["orchestrate", "worker_send", "orchestrate_result"]));
	});

	it("is stripped again on RELOAD, which re-activates every registered tool", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.setActiveTools([...pi.activeTools, "orchestrate"]); // pi's reload behaviour
		await pi.emit({ type: "session_start", reason: "reload" });
		expect(pi.activeTools).not.toContain("orchestrate");
	});

	it("becomes available after /ultracode on", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await pi.runCommand("ultracode", "on");
		expect(pi.activeTools).toContain("orchestrate");
	});

	it("goes away again on /ultracode off", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await pi.runCommand("ultracode", "on");
		await pi.runCommand("ultracode", "off");
		expect(pi.activeTools).not.toContain("orchestrate");
	});

	it("survives a /reload within the same session — reload is not a revocation", async () => {
		// A user reloads to pick up an edited extension, not to withdraw consent.
		// (In real pi a reload also re-runs this factory, which would reset the
		// flag anyway; the explicit handling below is what makes it a contract
		// rather than an accident of closure lifetime.)
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await pi.runCommand("ultracode", "on");

		await pi.emit({ type: "session_start", reason: "reload" });
		expect(pi.activeTools).toContain("orchestrate");
	});

	it("is revoked by a genuinely NEW session", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await pi.runCommand("ultracode", "on");

		await pi.emit({ type: "session_start", reason: "new" });
		expect(pi.activeTools).not.toContain("orchestrate");
	});

	it("read-modify-writes the live set, composing with plan-mode's wholesale replacement", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.setActiveTools(["read", "grep"]);

		await pi.runCommand("ultracode", "on");
		expect(pi.activeTools).toEqual(expect.arrayContaining(["read", "grep", "orchestrate"]));
	});
});

describe("/ultracode", () => {
	it("reports its state when called bare", async () => {
		agenda(pi.api);
		await pi.runCommand("ultracode", "");
		expect(pi.notifications.at(-1)?.message).toContain("off");
	});

	it("injects the plan-authoring doctrine WITHOUT triggering a turn", async () => {
		agenda(pi.api);
		await pi.runCommand("ultracode", "on");

		const injected = pi.messages.at(-1);
		expect(injected?.display).toBe(false);
		expect(injected?.options).toEqual({ deliverAs: "nextTurn" });
		expect(injected?.content).toContain("Fan out over ITEMS");
	});

	it("tells the model when a barrier is NOT justified", async () => {
		agenda(pi.api);
		await pi.runCommand("ultracode", "on");
		expect(pi.messages.at(-1)?.content).toContain("map or filter first");
	});
});

describe("the orchestrate tool", () => {
	function tool(name: "orchestrate" | "worker_send" | "orchestrate_result") {
		const found = pi.tools.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`${name} not registered`);
		return found.definition as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal?: AbortSignal,
				onUpdate?: unknown,
				ctx?: unknown,
			) => Promise<{ content: Array<{ text: string }>; details: any; isError?: boolean }>;
		};
	}

	const orchestrate = () => tool("orchestrate");

	const ctx = { cwd: "/home/dev/repos/hive-pi", ui: { confirm: async () => true } };

	it("rejects a plan naming an unknown role, and lists the real ones", async () => {
		agenda(pi.api);
		const result = await orchestrate().execute(
			"t1",
			{
				name: "p",
				description: "d",
				nodes: [{ id: "a", kind: "agent", role: "nonexistent-role", prompt: "x" }],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toContain("Plan rejected");
		expect(result.content[0].text).toContain("research");
	});

	it("rejects a cyclic plan", async () => {
		agenda(pi.api);
		const result = await orchestrate().execute(
			"t2",
			{
				name: "p",
				description: "d",
				nodes: [
					{ id: "a", kind: "agent", role: "research", prompt: "x", needs: ["b"] },
					{ id: "b", kind: "agent", role: "research", prompt: "y", needs: ["a"] },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toContain("cycle");
	});

	it("runs a valid plan and reports the spend", async () => {
		// `usage` is part of RoleAgentResult, so a fake that omits it is lying
		// about the contract — and `vi.fn()` is untyped, so tsc will not say so.
		runRoleAgent.mockResolvedValue({
			text: "worker output",
			tokens: 42,
			usage: { input: 30, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.0123 },
			exitCode: 0,
			timedOut: false,
			stderr: "",
		});
		agenda(pi.api);

		const result = await orchestrate().execute(
			"t3",
			{ name: "p", description: "d", nodes: [{ id: "a", kind: "agent", role: "research", prompt: "go" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toContain("1 agent(s)");
		expect(result.content[0].text).toContain("42 tokens");
		// Dollars are reported, not just tokens: a plan may set `model` per node,
		// so spend cannot be inferred from a token count afterwards.
		expect(result.content[0].text).toContain("$0.0123");
		expect(result.content[0].text).toContain("worker output");
	});

	it("returns control for a durable run, keeps its worker steerable, then pushes and retains completion", async () => {
		agenda(pi.api);
		const started = await orchestrate().execute(
			"durable-1",
			{
				name: "steerable",
				description: "background",
				nodes: [{ id: "a", kind: "agent", role: "research", prompt: "go", retries: 0 }],
				caps: { durable: true, maxConcurrent: 1 },
			},
			undefined,
			undefined,
			ctx,
		);
		const runId = started.details.run_id as string;
		expect(started.content[0].text).toContain("Background orchestration started");
		expect(runId).toMatch(/^run-[0-9a-f-]{36}$/);
		expect(durableHarness.ids).toHaveLength(1);

		const workerId = durableHarness.ids[0];
		const listed = await tool("worker_send").execute("workers", {});
		expect(listed.content[0].text).toContain(workerId);
		await tool("worker_send").execute("steer", { id: workerId, mode: "steer", message: "focus on the failing edge" });
		expect(durableHarness.sent).toEqual([{ id: workerId, mode: "steer", message: "focus on the failing edge" }]);

		durableHarness.completions[0]();
		await vi.waitFor(() => {
			expect(pi.messages.filter((message) => message.customType === "orchestrate")).toHaveLength(1);
		});
		const completion = pi.messages.find((message) => message.customType === "orchestrate")!;
		expect(completion.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(completion.content).toContain(runId);

		const retained = await tool("orchestrate_result").execute("result", { id: runId });
		expect(retained.content[0].text).toContain(`result:${workerId}`);
	});

	it("stops one durable worker intentionally and lets its run complete without a failure", async () => {
		agenda(pi.api);
		const started = await orchestrate().execute(
			"durable-stop",
			{
				name: "stop redundant",
				description: "stop",
				nodes: [{ id: "a", kind: "agent", role: "research", prompt: "go", retries: 0 }],
				caps: { durable: true, maxConcurrent: 1 },
			},
			undefined,
			undefined,
			ctx,
		);
		const workerId = durableHarness.ids[0];
		const stopped = await tool("worker_send").execute("stop", { id: workerId, mode: "stop" });
		expect(stopped.content[0].text).toContain("Stopped");
		expect(durableHarness.stopped).toEqual([workerId]);

		await vi.waitFor(() => {
			expect(pi.messages.some((message) => message.customType === "orchestrate")).toBe(true);
		});
		const retained = await tool("orchestrate_result").execute("result", { id: started.details.run_id });
		expect(retained.content[0].text).toContain("stopped_by_orchestrator");
		expect(retained.content[0].text).not.toContain("node(s) failed");
	});

	it("gives identical follow-up waves distinct run and worker ids", async () => {
		agenda(pi.api);
		const plan = {
			name: "same wave",
			description: "same",
			nodes: [{ id: "a", kind: "agent", role: "research", prompt: "go", retries: 0 }],
			caps: { durable: true, maxConcurrent: 1 },
		};
		const first = await orchestrate().execute("wave-1", plan, undefined, undefined, ctx);
		const second = await orchestrate().execute("wave-2", plan, undefined, undefined, ctx);
		expect(first.details.run_id).not.toBe(second.details.run_id);
		expect(new Set(durableHarness.ids).size).toBe(2);
		for (const complete of durableHarness.completions) complete();
	});

	it("surfaces a worker failure rather than reporting an empty success", async () => {
		// "n/m succeeded with m=0" reported as success is the success-shaped-
		// nothing failure this whole design is trying to avoid.
		runRoleAgent.mockResolvedValue({
			text: "",
			tokens: 1,
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0002 },
			exitCode: 2,
			timedOut: false,
			stderr: "no such model",
		});
		agenda(pi.api);

		const result = await orchestrate().execute(
			"t4",
			{ name: "p", description: "d", nodes: [{ id: "a", kind: "agent", role: "research", prompt: "go" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toContain("failed");
		expect(result.content[0].text).toContain("exited 2");
	});

	/** A worker that answers each node with `outputs[nodeId-from-prompt]`. */
	function answerBy(outputs: Record<string, string>) {
		runRoleAgent.mockImplementation(async ({ prompt }: { prompt: string }) => {
			// With inputs the authored task comes last, under "## Your task".
			const task = prompt.split("## Your task\n").at(-1) ?? prompt;
			const node = Object.keys(outputs).find((id) => task.startsWith(`do ${id}`)) ?? "";
			return {
				text: outputs[node] ?? `out ${node}`,
				tokens: 1,
				usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				exitCode: 0,
				timedOut: false,
				stderr: "",
			};
		});
	}

	// Papercuts 2026-10-02T14:14, 10-02T22:5x, 10-03T00:1x: the result was
	// `JSON.stringify(results).slice(0, 24_000)` — it "ended mid-string in
	// reviews#2 ('disappe')", the reconciler's verdict past the cut was
	// unreachable, and orchestrate_result took only an id.
	it("never cuts the result silently: it says what was cut and pages the rest by node and offset", async () => {
		const long = `BEGIN-REVIEW\n${"a finding that matters\n".repeat(1_500)}VERDICT: disappears without paging`;
		answerBy({ review: long, reconcile: "RECONCILED: ship it" });
		agenda(pi.api);

		const result = await orchestrate().execute(
			"paged",
			{
				name: "p",
				description: "d",
				nodes: [
					{ id: "review", kind: "agent", role: "research", prompt: "do review", retries: 0 },
					{ id: "reconcile", kind: "agent", role: "research", prompt: "do reconcile", retries: 0, needs: ["review"] },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const runId = result.details.run_id as string;
		expect(runId).toMatch(/^run-/);
		const shown = result.content[0].text;
		expect(shown).toMatch(/showing characters 0–\d+ of \d+/);
		expect(shown).toContain(`orchestrate_result({id:"${runId}", offset:`);
		expect(shown).toContain('node:"reconcile"');

		// One node, whole, across pages — fenced as worker data, and the hint
		// for the next page keeps the caller's own page size.
		const pages: string[] = [];
		let offset = 0;
		for (let guard = 0; guard < 10; guard++) {
			const page = await tool("orchestrate_result").execute("r", { id: runId, node: "review", offset, limit: 10_000 });
			expect(page.isError).toBeFalsy();
			pages.push(page.details.page as string);
			if (page.details.next_offset === undefined) break;
			expect(page.content[0].text).toContain(`offset:${page.details.next_offset}, limit:10000})`);
			offset = page.details.next_offset as number;
		}
		expect(pages.join("")).toMatch(new RegExp(`<<<WORKER OUTPUT node=review nonce=(\\w+)>>>\\n${long.slice(0, 40)}`));
		expect(pages.join("")).toContain(`${long}\n<<<END WORKER OUTPUT nonce=`);

		// A page size past the ceiling is clamped, not honoured.
		const huge = await tool("orchestrate_result").execute("r", { id: runId, offset: 0, limit: 1_000_000_000 });
		expect((huge.details.page as string).length).toBeLessThanOrEqual(MAX_RESULT_PAGE_CHARS);

		const reconciled = await tool("orchestrate_result").execute("r", { id: runId, node: "reconcile" });
		expect(reconciled.content[0].text).toContain("RECONCILED: ship it");
		expect(reconciled.content[0].text).toContain("complete");
	});

	it("selects one element of a fanout by its slot id, and names the selectable ids for an unknown one", async () => {
		runRoleAgent.mockImplementation(async ({ prompt }: { prompt: string }) => ({
			text: prompt.startsWith("do reviews") ? `reviewed ${prompt.split(" ").at(-1)}` : prompt === "do a" ? "alpha" : "beta",
			tokens: 1,
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			exitCode: 0,
			timedOut: false,
			stderr: "",
		}));
		agenda(pi.api);
		const result = await orchestrate().execute(
			"fan",
			{
				name: "p",
				description: "d",
				nodes: [
					{ id: "a", kind: "agent", role: "research", prompt: "do a", retries: 0 },
					{ id: "b", kind: "agent", role: "research", prompt: "do b", retries: 0 },
					{ id: "files", kind: "barrier", needs: ["a", "b"] },
					{ id: "reviews", kind: "fanout", over: "files", role: "research", prompt: "do reviews {item}", retries: 0 },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const runId = result.details.run_id as string;
		const second = await tool("orchestrate_result").execute("r", { id: runId, node: "reviews#1" });
		expect(second.content[0].text).toContain("reviewed beta");
		expect(second.content[0].text).not.toContain("reviewed alpha");

		const unknown = await tool("orchestrate_result").execute("r", { id: runId, node: "nope" });
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toContain("reviews#0");
		expect(unknown.content[0].text).toContain("files");
	});

	it("forwards an upstream result too large to inline as a file the dependent worker can read", async () => {
		const store = mkdtempSync(join(tmpdir(), "hive-pi-orch-inputs-"));
		vi.stubEnv("PI_ARTIFACT_DIR", store);
		const big = `${"evidence line\n".repeat(3_000)}END-OF-EVIDENCE`;
		answerBy({ evidence: big });
		agenda(pi.api);
		await orchestrate().execute(
			"fwd",
			{
				name: "p",
				description: "d",
				nodes: [
					{ id: "evidence", kind: "agent", role: "research", prompt: "do evidence", retries: 0 },
					{ id: "reconcile", kind: "agent", role: "research", prompt: "do reconcile", retries: 0, needs: ["evidence"] },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const reconcilePrompt = runRoleAgent.mock.calls.map(([options]) => options.prompt as string).find((prompt) => prompt.endsWith("## Your task\ndo reconcile"));
		const file = /written in full to (\S+?) —/.exec(reconcilePrompt ?? "")?.[1];
		expect(file?.startsWith(store), reconcilePrompt).toBe(true);
		expect(readFileSync(file!, "utf8")).toBe(big);
	});

	it("refuses to nest — depth 1 only", async () => {
		vi.stubEnv("PI_AGENDA_WORKER", "1");
		vi.resetModules();
		const fresh = createFakePi();
		const { default: workerAgenda } = await import("../extensions/agenda/index.ts");
		workerAgenda(fresh.api);

		const tool = fresh.tools.find((t) => t.name === "orchestrate");
		const result = await (tool!.definition as { execute: Function }).execute("t5", {}, undefined, undefined, ctx);
		expect(result.content[0].text).toContain("not available inside a worker");

		vi.unstubAllEnvs();
		vi.resetModules();
	});
});
