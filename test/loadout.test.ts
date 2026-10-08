/**
 * The tool loadout: a small always-declared set, everything else on demand.
 *
 * `tool-capability.test.ts` checks every real registration against the policy.
 * This file checks the behaviour around it: the names the model is told about,
 * and that the plan and bugfix modes activate their deferred tools and give
 * back what `tool_search` loaded while they ran.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import loadoutExtension, { deferredToolNames, LOAD_TOOL, loadoutPrompt, mcpHint, planLoad } from "../extensions/loadout/index.ts";
import { exposureFor, GATED_TOOLS, restoredLoadout } from "../extensions/loadout/policy.ts";
import opmodeExtension from "../extensions/opmode/index.ts";
import planExtension from "../extensions/plan/index.ts";
import agendaExtension from "../extensions/agenda/index.ts";
import { createJob, finishJob, resultHeader, statusForExit } from "../extensions/background/jobs.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

describe("exposureFor", () => {
	it("declares the hot set and defers everything else, including tools it has never heard of", () => {
		expect(exposureFor("bash")).toBe("direct");
		expect(exposureFor("browser_click")).toBe("deferred");
		expect(exposureFor("plan_write")).toBe("deferred");
		expect(exposureFor("a_tool_added_next_year")).toBe("deferred");
	});

	it("never defers a consent-gated tool: deferred is callable from codemode and loadable", () => {
		for (const name of Object.keys(GATED_TOOLS)) expect(exposureFor(name)).toBe("direct");
	});
});

describe("restoredLoadout", () => {
	it("restores the snapshot, keeps tools loaded during the mode, and drops the mode's own tools", () => {
		const before = ["bash", "edit"];
		const during = ["bash", "plan_write", "browser_click"];
		expect(restoredLoadout(before, during, ["plan_write", "plan_ready"]).sort()).toEqual(["bash", "browser_click", "edit"]);
	});

	it("keeps a mode tool that was already active before the mode", () => {
		expect(restoredLoadout(["plan_write"], ["plan_write"], ["plan_write"])).toEqual(["plan_write"]);
	});
});

describe("the on-demand index", () => {
	it("names deferred harness tools only — not MCP tools, not mode tools, not declared ones", () => {
		const names = deferredToolNames([
			{ name: "bash", exposure: "direct" },
			{ name: "session_grep", exposure: "deferred" },
			{ name: "browser_click", exposure: "deferred" },
			{ name: "mcp__hive__get_run", exposure: "deferred" },
			{ name: "plan_write", exposure: "deferred" },
		]);
		expect(names).toEqual(["browser_click", "session_grep"]);
	});

	it("is stable while tools load, so the cached prompt prefix survives", async () => {
		const pi = createFakePi();
		for (const name of ["bash", "session_grep", "browser_click"]) {
			pi.api.registerTool({ name, label: name, description: name, parameters: {}, exposure: exposureFor(name), execute: async () => ({ content: [], details: {} }) } as never);
		}
		loadoutExtension(pi.api);
		expect(pi.activeTools).toContain(LOAD_TOOL);
		const prompt = async () => {
			const results = await pi.emit({ type: "before_agent_start", prompt: "x", systemPrompt: "BASE" } as never);
			return (results as Array<{ systemPrompt?: string } | undefined>).find((r) => r?.systemPrompt)?.systemPrompt;
		};
		const first = await prompt();
		expect(first).toContain("browser_click, session_grep");
		expect(first).toContain(LOAD_TOOL);
		pi.api.setActiveTools([...pi.api.getActiveTools(), "browser_click"]);
		expect(await prompt()).toBe(first);
	});

	it("distinguishes native discovery from codemode's async globals", () => {
		const prompt = loadoutPrompt(["session_grep"]);
		expect(prompt).toContain('await searchTools("<words>")');
		expect(prompt).toContain('await describeTool("<exact name>")');
		expect(prompt).toContain("never `tools.tool_search` (it is model-only)");
		expect(prompt).toContain("they do not need `load_tools` first");
	});

	it("says nothing when nothing is deferred", () => {
		expect(loadoutPrompt([])).toBe("");
	});

	it("says nothing when the loader is not declared (a worker restricted by --tools)", async () => {
		const pi = createFakePi();
		pi.api.registerTool({ name: "session_grep", label: "s", description: "s", parameters: {}, exposure: "deferred", execute: async () => ({ content: [], details: {} }) } as never);
		loadoutExtension(pi.api);
		pi.api.setActiveTools(["bash"]);
		const results = await pi.emit({ type: "before_agent_start", prompt: "x", systemPrompt: "BASE" } as never);
		expect((results as unknown[]).filter(Boolean)).toEqual([]);
	});
});

describe("load_tools", () => {
	const tools = [
		{ name: "artifact_read", exposure: "deferred" },
		{ name: "artifact_list", exposure: "deferred" },
		{ name: "orchestrate", exposure: "direct" },
		{ name: "bash", exposure: "direct" },
		{ name: "ghost", exposure: "hidden" },
	];

	it("loads exactly the names asked for — never a neighbour BM25 would rank first", () => {
		expect(planLoad(["artifact_read"], tools, ["bash"])).toEqual({ load: ["artifact_read"], already: [], refused: [] });
	});

	it("refuses a consent-gated (direct, inactive) tool, a hidden one, and an unknown name", () => {
		expect(planLoad(["orchestrate", "ghost", "nope"], tools, ["bash"]).refused).toEqual(["orchestrate", "ghost", "nope"]);
	});

	it("reports an active tool as already available, and de-duplicates", () => {
		expect(planLoad(["bash", "artifact_list", "artifact_list"], tools, ["bash"])).toEqual({ load: ["artifact_list"], already: ["bash"], refused: [] });
	});

	it("activates through the real tool, and errors when nothing could be loaded", async () => {
		const pi = createFakePi();
		pi.api.registerTool({ name: "artifact_read", label: "a", description: "a", parameters: {}, exposure: "deferred", execute: async () => ({ content: [], details: {} }) } as never);
		loadoutExtension(pi.api);
		const tool = pi.tools.find((t) => t.name === LOAD_TOOL);
		const execute = (tool?.definition as { execute: (...a: unknown[]) => Promise<{ isError?: boolean; content: { text: string }[] }> }).execute;
		const ok = await execute("c", { names: ["artifact_read"] });
		expect(ok.isError).toBe(false);
		expect(pi.activeTools).toContain("artifact_read");
		const bad = await execute("c", { names: ["nope"] });
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toContain("Not loadable");
		// No tool_search is registered here, so the hint must not send the
		// agent looking for one.
		expect(bad.content[0].text).not.toContain("load with tool_search");
		expect(bad.content[0].text).toContain("no MCP servers configured");
	});

	it("points at tool_search only when the session has it", () => {
		const withSearch = { getAllTools: () => [{ name: "tool_search" }] } as never;
		const without = { getAllTools: () => [{ name: "read" }] } as never;
		expect(mcpHint(withSearch)).toContain("tool_search outside codemode");
		expect(mcpHint(withSearch)).toContain("await searchTools(query)");
		expect(mcpHint(without)).toContain("no MCP servers configured");
	});
});

describe("consent-gated tools stay unreachable without consent", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("orchestrate is registered direct and kept inactive, so neither load_tools nor tool_search can reach it", async () => {
		// This is the ordinary non-launched consent path, independent of the
		// agent or CI process running the suite.
		vi.stubEnv("HIVE_LAUNCH_ID", undefined);
		const pi = createFakePi();
		agendaExtension(pi.api);
		loadoutExtension(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		expect(pi.activeTools).not.toContain("orchestrate");
		const info = pi.api.getAllTools().find((t) => t.name === "orchestrate");
		expect(info?.exposure).toBe("direct");
		expect(planLoad(["orchestrate"], pi.api.getAllTools(), pi.api.getActiveTools()).refused).toEqual(["orchestrate"]);
	});
	it("a Hive-launched session keeps its explicitly authorized orchestration tools active", async () => {
		vi.stubEnv("HIVE_LAUNCH_ID", "123e4567-e89b-42d3-a456-426614174000");
		const pi = createFakePi(); agendaExtension(pi.api); loadoutExtension(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		expect(pi.activeTools).toContain("orchestrate");
		expect(planLoad(["orchestrate"], pi.api.getAllTools(), pi.api.getActiveTools()).already).toEqual(["orchestrate"]);
	});
});

const TOOLS = ["bash", "read", "edit", "write", "grep", "session_grep"];

async function boot(): Promise<FakePi> {
	const pi = createFakePi();
	planExtension(pi.api);
	opmodeExtension(pi.api);
	// Plain stand-ins for tools other extensions own, registered the way the
	// policy says. The mode extensions register their own real tools above.
	const owned = new Set(pi.tools.map((tool) => tool.name));
	for (const name of TOOLS.filter((n) => !owned.has(n))) {
		pi.api.registerTool({ name, label: name, description: name, parameters: {}, exposure: exposureFor(name), execute: async () => ({ content: [], details: {} }) } as never);
	}
	await pi.emit({ type: "session_start", reason: "startup" });
	return pi;
}

const active = (pi: FakePi) => new Set(pi.api.getActiveTools());

describe("mode tools", () => {
	it("are not declared in build mode", async () => {
		const pi = await boot();
		for (const name of ["plan_write", "bugfix_evidence", "bugfix_root_cause"]) expect(active(pi).has(name)).toBe(false);
		expect(active(pi).has("bash")).toBe(true);
	});

	it("plan mode declares its tools without declaring every deferred tool it permits, and gives them back", async () => {
		const pi = await boot();
		await pi.runCommand("plan", "start");
		expect(active(pi).has("plan_write")).toBe(true);
		expect(active(pi).has("plan_ready")).toBe(true);
		// `session_grep` is read-only, so plan mode permits it — but permitting
		// is not loading. Narrowing works on the ACTIVE set.
		expect(active(pi).has("session_grep")).toBe(false);

		// The model loads it with tool_search during planning…
		pi.api.setActiveTools([...pi.api.getActiveTools(), "session_grep"]);
		await pi.runCommand("plan", "exit");

		// …and keeps it after. With no plan written, plan_write goes away again;
		// plan_ready and plan_ask are direct and stay.
		expect(active(pi).has("session_grep")).toBe(true);
		expect(active(pi).has("plan_write")).toBe(false);
		expect(active(pi).has("plan_ready")).toBe(true);
		expect(active(pi).has("edit")).toBe(true);
	});

	it("keeps plan_write declared after plan mode while a plan exists — execution updates step status with it", async () => {
		const pi = await boot();
		await pi.runCommand("plan", "start");
		const planWrite = pi.tools.find((t) => t.name === "plan_write");
		const execute = (planWrite?.definition as { execute: (...a: unknown[]) => Promise<{ isError?: boolean; content: { text: string }[] }> }).execute;
		const wrote = await execute("c", { ops: [{ op: "header", title: "Ship it", goal: "ship it", phase: "drafting" }] }, undefined, undefined, { mode: "tui", cwd: "/tmp", hasUI: false, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} }, sessionManager: { getEntries: () => [], getBranch: () => [] } });
		expect(wrote.isError, wrote.content[0]?.text).not.toBe(true);
		await pi.runCommand("plan", "exit");
		expect(active(pi).has("plan_write")).toBe(true);
	});

	it("keeps bugfix_evidence through the reverify phase after the root-cause unlock", async () => {
		const pi = await boot();
		await pi.runCommand("mode", "bugfix");
		const tool = (name: string) =>
			(pi.tools.find((t) => t.name === name)?.definition as { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }).execute;
		// A failing run, pulled from the background, binds the reproduction —
		// built through the shipping header code, as the opmode suite does.
		let job = createJob({ id: "bg-1", what: "run the test", kind: "bash", detail: "npm test", startedAtMs: 0 });
		job = finishJob({ ...job, output: "FAIL" }, { status: statusForExit(1), exitCode: 1, endedAtMs: 1 });
		await pi.emit({ type: "tool_result", toolCallId: "c1", toolName: "background_result", isError: false, content: [{ type: "text", text: `${resultHeader(job, 1)}\n\nFAIL` }] });
		const evidence = tool("bugfix_evidence");
		const steps: string[] = [];
		const step = async (id: string, params: Record<string, unknown>) => steps.push((await evidence(id, params)).content[0].text);
		await step("e1", { phase: "reproduce", tool_call_id: "bg-1", reproduction_key: "k" });
		await step("e2", { phase: "hypothesize", tool_call_id: "bg-1", hypothesis: "off by one" });
		await pi.emit({ type: "tool_result", toolCallId: "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "i=n" }] });
		await step("e3", { phase: "instrument", tool_call_id: "c2" });
		await step("e4", { phase: "confirm", tool_call_id: "c2", hypothesis: "off by one at i=n" });
		const unlocked = await tool("bugfix_root_cause")("r", { summary: "off-by-one", evidence: "i=n read past the end" });
		expect(unlocked.content[0].text, steps.join("\n---\n")).toContain("unlocked");

		// Editors back, and the evidence tool still there for reverify.
		expect(active(pi).has("edit")).toBe(true);
		expect(active(pi).has("bugfix_evidence")).toBe(true);

		await pi.runCommand("mode", "build");
		expect(active(pi).has("bugfix_evidence")).toBe(false);
		expect(active(pi).has("edit")).toBe(true);
	});

	it("bugfix mode declares its evidence tools, and build mode withdraws them", async () => {
		const pi = await boot();
		await pi.runCommand("mode", "bugfix");
		expect(active(pi).has("bugfix_evidence")).toBe(true);
		expect(active(pi).has("bugfix_root_cause")).toBe(true);
		await pi.runCommand("mode", "build");
		expect(active(pi).has("bugfix_evidence")).toBe(false);
		expect(active(pi).has("edit")).toBe(true);
	});
});
