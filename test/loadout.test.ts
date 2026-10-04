/**
 * The tool loadout: a small always-declared set, everything else on demand.
 *
 * `tool-capability.test.ts` checks every real registration against the policy.
 * This file checks the behaviour around it: the names the model is told about,
 * and that the plan and bugfix modes activate their deferred tools and give
 * back what `tool_search` loaded while they ran.
 */

import { describe, expect, it } from "vitest";

import loadoutExtension, { deferredToolNames, loadoutPrompt } from "../extensions/loadout/index.ts";
import { exposureFor, restoredLoadout } from "../extensions/loadout/policy.ts";
import opmodeExtension from "../extensions/opmode/index.ts";
import planExtension from "../extensions/plan/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

describe("exposureFor", () => {
	it("declares the hot set and defers everything else, including tools it has never heard of", () => {
		expect(exposureFor("bash")).toBe("direct");
		expect(exposureFor("browser_click")).toBe("deferred");
		expect(exposureFor("plan_write")).toBe("deferred");
		expect(exposureFor("a_tool_added_next_year")).toBe("deferred");
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
		const prompt = async () => {
			const results = await pi.emit({ type: "before_agent_start", prompt: "x", systemPrompt: "BASE" } as never);
			return (results as Array<{ systemPrompt?: string } | undefined>).find((r) => r?.systemPrompt)?.systemPrompt;
		};
		const first = await prompt();
		expect(first).toContain("browser_click, session_grep");
		expect(first).toContain("tool_search");
		pi.api.setActiveTools([...pi.api.getActiveTools(), "browser_click"]);
		expect(await prompt()).toBe(first);
	});

	it("says nothing when nothing is deferred", () => {
		expect(loadoutPrompt([])).toBe("");
	});
});

const TOOLS = ["bash", "read", "edit", "write", "grep", "plan_write", "plan_ask", "plan_ready", "bugfix_evidence", "bugfix_root_cause", "session_grep"];

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
		for (const name of ["plan_write", "plan_ready", "bugfix_evidence", "bugfix_root_cause"]) expect(active(pi).has(name)).toBe(false);
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

		// …and keeps it after; the plan tools go away again.
		expect(active(pi).has("session_grep")).toBe(true);
		expect(active(pi).has("plan_write")).toBe(false);
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
