/** Startup posture through real extension factories; only retrieval and HTTP are stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFakePi, scopedExtensionApi, type FakePi } from "./fake-pi.ts";
import { rehydratePlan } from "../extensions/plan/state.ts";
import { READ_ONLY_MCP_TOOLS } from "../extensions/plan/policy.ts";
import { nativeMcpToolName } from "../extensions/mcp-common/names.ts";
import opmode from "../extensions/opmode/index.ts";
import plan from "../extensions/plan/index.ts";
import agenda from "../extensions/agenda/index.ts";
import brief from "../extensions/brief/index.ts";
import hiveRemote from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";
import { HIVE_SESSION_CHANNEL, OP_MODE_STATE_CHANNEL, PLAN_CONTROL_CHANNEL, QUESTION_REMOTE_CHANNEL, CONDUCTOR_CHANNEL } from "../extensions/hive-common/channels.ts";

const runBriefer = vi.hoisted(() => vi.fn());
vi.mock("../extensions/brief/run.ts", () => ({ runBriefer, BRIEFER_ROLE: "briefer" }));
const TASK = "Fix the docs/guide.md heading and update docs/how-pi-works.md and extensions/plan/index.ts so the PR describes the plan mode launch contract";
const URL_BASE = "https://hive.test";
const config: RemoteConfig = {
	enabled: true, url: URL_BASE, flushIntervalMs: 1_000, eventThreshold: 200,
	allowSteer: true, allowInterrupt: true, allowKill: true, allowSetMode: true, allowSetOpMode: true,
	reportStatus: true, streamDeltas: false, streamThinking: false, reportActivity: false,
	reportWorktree: false, allowAddWorkspace: false,
};
let statuses: Array<{ op_mode?: string }>;
let fake: FakePi;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("HIVE_LAUNCH_ID", "11111111-2222-3333-4444-555555555555");
	vi.stubEnv("PI_BRIEF_AUTO", "1");
	vi.stubEnv("PI_BRIEF_DISABLED", "0");
	runBriefer.mockClear();
	statuses = [];
	fake = createFakePi();
	runBriefer.mockResolvedValue({
		draft: { goal: TASK, facts: [], startHere: [], refs: [], unknowns: [], nextMoves: [], history: [] },
		failure: "", model: "cheap/model", modelSource: "mode:low", usage: null, elapsedMs: 1, timedOut: false, lanes: [],
	});
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		if (path.endsWith("/status")) statuses.push(body);
		const response = path.includes("/by-run/") ? { id: "sess-1" }
			: path.endsWith("/conversation") ? { session_id: "sess-1", last_seq: 0 }
			: path.endsWith("/commands/claim") ? { items: [] } : {};
		return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
	});
});
afterEach(async () => {
	await fake.emit({ type: "session_shutdown" });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function boot(planFirst: boolean, extraTools: string[] = []) {
	for (const name of ["read", "write", "edit", "bash", ...extraTools]) fake.api.registerTool({
		name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: {} }),
	} as never);
	// agenda/brief/hive-remote precede opmode/plan in normal directory discovery.
	agenda(scopedExtensionApi(fake));
	brief(scopedExtensionApi(fake));
	hiveRemote(scopedExtensionApi(fake), { loadConfig: () => config, resolveAuth: () => ({ token: "t", url: URL_BASE, source: "test" }) });
	const opmodeApi = scopedExtensionApi(fake), planApi = scopedExtensionApi(fake);
	for (const [extension, api] of planFirst ? [[plan, planApi], [opmode, opmodeApi]] as const : [[opmode, opmodeApi], [plan, planApi]] as const) extension(api);
	fake.flags.set("op-mode", "plan");
	expect(opmodeApi.getFlag("op-mode")).toBe("plan");
	expect(planApi.getFlag("op-mode")).toBeUndefined();
	expect(opmodeApi.getFlag("plan")).toBeUndefined();
	await fake.emit({ type: "session_start", reason: "startup" });
	fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-abc" });
	await vi.advanceTimersByTimeAsync(10_000);
}

async function isBlocked(toolName = "write", input: unknown = { path: "src/new.ts", content: "x" }) {
	return (await fake.emit({ type: "tool_call", toolName, input })).some(v => (v as { block?: boolean } | undefined)?.block);
}

type Execute = (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ content: Array<{ text: string }> }>;
function execute(name: string, params: unknown) {
	const tool = fake.tools.find(t => t.name === name)!;
	const ctx = { mode: "tui", cwd: "/tmp/fake-repo", sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
	return (tool.definition.execute as Execute)(name, params, undefined, undefined, ctx);
}

describe("Hive-launched plan startup", () => {
	it("keeps live research visible at startup and gates direct and gateway calls", async () => {
		const names = [...READ_ONLY_MCP_TOOLS].flatMap(name => {
			const separator = name.indexOf("_");
			return [name, nativeMcpToolName(name.slice(0, separator), name.slice(separator + 1))];
		});
		await boot(false, ["mcp", ...names]);
		for (const name of names) {
			expect(fake.activeTools, name).not.toContain(name);
			expect(await isBlocked(name, {}), name).toBe(true);
			expect(await isBlocked("mcp", { tool: name, args: {} }), name).toBe(false);
		}
		expect(fake.activeTools).toContain("mcp");
		expect(await isBlocked("session_context", { goal: "Research", approach: "Read live state" })).toBe(false);
		expect(await isBlocked("mcp", { tool: "hive_cancel_run" })).toBe(true);
		expect(await isBlocked("mcp__hive__new_unknown_tool", {})).toBe(true);
		expect(await isBlocked()).toBe(true);
	});
	it("session_context persists and syncs only this session's kickoff metadata in plan mode", async () => {
		const requests: Array<{ path: string; method: string; body: Record<string, unknown> | undefined }> = [];
		let identity = { title: "Research", description: "", description_provisional: false, identity_revision: 0 };
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			const path = String(url).replace(`${URL_BASE}/api/v1`, "");
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			requests.push({ path, method: init?.method ?? "GET", body });
			if (path.endsWith("/identity")) identity = {
				title: body.title ?? identity.title, description: body.description,
				description_provisional: body.provisional, identity_revision: body.revision,
			};
			const response = path.includes("/by-run/") ? { id: "sess-1" }
				: path.endsWith("/conversation") ? { ...identity, session_id: "sess-1", last_seq: 0, can_report_identity: true }
				: path.endsWith("/identity") ? identity
				: path.endsWith("/commands/claim") ? { items: [] } : {};
			return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		await boot(false);
		const before = requests.length;
		const entryCount = fake.entries.length;
		expect(await isBlocked("session_context", { goal: "Research", approach: "Read live state" })).toBe(false);
		await execute("session_context", { goal: "Research", approach: "Read live state" });
		await vi.advanceTimersByTimeAsync(0);
		expect(requests.slice(before).filter(r => r.method !== "GET")).toEqual([{
			path: "/agent-sessions/sess-1/identity", method: "PUT",
			body: { revision: 1, title: "Session", description: "Goal: Research. Approach: Read live state", provisional: false, source: "initial" },
		}]);
		expect(fake.entries.slice(entryCount).every(e => e.customType === "session-identity" || e.customType === "session-identity-sync")).toBe(true);
		expect(identity.description).toBe("Goal: Research. Approach: Read live state");
		expect(await isBlocked()).toBe(true);
	});

	it.each([false, true])("denies writes at first turn, survives brief/conductor, and reports plan first (planFirst=%s)", async planFirst => {
		await boot(planFirst);
		expect(await isBlocked()).toBe(true);
		expect(await isBlocked("bash", { command: "printf x > src/new.ts" })).toBe(true);
		expect(fake.activeTools).not.toContain("write");
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses[0]?.op_mode).toBe("plan");
		expect(new Set(fake.busEvents.filter(e => e.name === OP_MODE_STATE_CHANNEL).map(e => (e.payload as { mode: string }).mode))).toEqual(new Set(["plan"]));
		// The very first plan_ready must recognize the posture even before plan_write.
		expect((await execute("plan_ready", {})).content[0].text).toBe("The plan is empty. Build it with plan_write before presenting it.");

		const branch = [{ message: { role: "user", content: TASK } }, { message: { role: "assistant", content: "I will inspect the heading." } }];
		const result = await fake.emit({ type: "before_agent_start", prompt: TASK, systemPrompt: "base" }, { branch });
		expect(runBriefer).toHaveBeenCalled();
		expect(result.some(r => (r as { message?: { customType?: string } } | undefined)?.message?.customType === "brief")).toBe(true);
		await fake.emit({ type: "agent_before_settle" }, { branch });
		await fake.emit({ type: "agent_before_settle" }, { branch });
		expect(fake.busEvents.filter(e => e.name === CONDUCTOR_CHANNEL).map(e => (e.payload as { stage: string }).stage)).toEqual(["frame", "plan"]);
		expect(await isBlocked()).toBe(true);
		// Stage bookkeeping is not approval: the smoke transcript later said execute.
		fake.api.events.emit(CONDUCTOR_CHANNEL, { stage: "execute" });
		expect(await isBlocked()).toBe(true);

		await execute("plan_write", { ops: [
			{ op: "header", title: "Fix heading", goal: TASK },
			{ op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "Read the heading" }, { title: "Fix and verify" }] } },
		] });
		fake.api.events.emit(QUESTION_REMOTE_CHANNEL, { available: true });
		let settled = false;
		const pending = execute("plan_ready", {}).then(r => { settled = true; return r; });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(rehydratePlan(fake.entries)?.phase).toBe("ready");
		expect(await isBlocked()).toBe(true);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "approve" });
		const ready = await pending;
		expect(ready.content[0].text).toMatch(/^Plan is ready and awaiting approval:/);
		expect(ready.content[0].text).toContain("Approved");
		expect(await isBlocked()).toBe(false);
		expect(fake.activeTools).toContain("write");
		await vi.advanceTimersByTimeAsync(1);
		expect(statuses.at(-1)?.op_mode).toBe("build");
	});
});
