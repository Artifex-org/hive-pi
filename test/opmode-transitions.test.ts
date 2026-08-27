/**
 * What happens to the ACTIVE TOOL SET as the operating mode moves — the layer
 * the pure tests in opmode.test.ts cannot reach.
 *
 * Both extensions are loaded into one FakePi, because the bug this file exists
 * to pin is an INTERACTION: `opmode` delegates the plan posture to the `plan`
 * extension, and both of them snapshot and restore the active tool set. Testing
 * either alone proves nothing about the pair.
 *
 * The failure being pinned is silent and survives a session. Leaving bugfix for
 * plan used to restore opmode's snapshot AFTER plan had already snapshotted the
 * bugfix-narrowed set; `/plan exit` then restored that stale set, leaving a
 * BUILD-mode session with no `edit` tool and nothing on screen to explain it.
 * The deny hooks were correct throughout, so nothing blocked and nothing warned
 * — the tool was simply gone until a reload.
 */

import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";

// The profile is module-level state; a test that sets one must not leak it into
// the next, or a later assertion passes for the previous test's reason.
afterEach(() => setHouseProfileForTest(null));

import opmodeExtension from "../extensions/opmode/index.ts";
import planExtension from "../extensions/plan/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

/** The tools whose presence the assertions turn on, plus a couple of readers. */
const TOOLS = ["edit", "write", "read", "grep", "bash", "mcp", "mcpScript", "render_chart"];

async function boot(): Promise<FakePi> {
	const pi = createFakePi();
	for (const name of TOOLS) {
		pi.api.registerTool({
			name,
			label: name,
			description: name,
			parameters: {},
			execute: async () => ({ content: [], details: {} }),
		} as never);
	}
	// Load order mirrors production: both are plain extensions on one bus.
	planExtension(pi.api);
	opmodeExtension(pi.api);
	await pi.emit({ type: "session_start", reason: "startup" });
	return pi;
}

const active = (pi: FakePi) => new Set(pi.api.getActiveTools());

describe("tool-set ownership across mode transitions", () => {
	it("starts in build with every tool active", async () => {
		const pi = await boot();
		expect(active(pi).has("edit")).toBe(true);
	});

	it("withholds the editors in bugfix and gives them back in build", async () => {
		const pi = await boot();

		await pi.runCommand("mode", "bugfix");
		expect(active(pi).has("edit")).toBe(false);
		// The investigation tools stay — the whole point of the narrower gate.
		expect(active(pi).has("bash")).toBe(true);
		expect(active(pi).has("read")).toBe(true);

		await pi.runCommand("mode", "build");
		expect(active(pi).has("edit")).toBe(true);
	});

	// THE REGRESSION. Every step matters: bugfix narrows, plan snapshots and
	// narrows over it, plan exits and restores, and build must still have `edit`.
	it("does not strand a narrowed tool set when plan follows bugfix", async () => {
		const pi = await boot();

		await pi.runCommand("mode", "bugfix");
		expect(active(pi).has("edit")).toBe(false);

		await pi.runCommand("mode", "plan");
		await pi.runCommand("plan", "exit");

		// `/plan exit` announces plan is off, which syncs opmode back to build.
		expect(active(pi).has("edit")).toBe(true);
	});

	// The mirror path: `/plan` typed directly, arriving at opmode silently over
	// PLAN_MODE_STATE_CHANNEL rather than being driven by it.
	it("does not strand a narrowed tool set when /plan is typed during bugfix", async () => {
		const pi = await boot();

		await pi.runCommand("mode", "bugfix");
		await pi.runCommand("plan", "start");
		await pi.runCommand("plan", "exit");

		expect(active(pi).has("edit")).toBe(true);
	});

	// The opposite direction, which is why the plan doorbell is emitted BEFORE
	// the tool block rather than after: plan must restore its snapshot first, or
	// discuss would narrow from plan's narrowed set and plan would then restore
	// over the narrowing.
	it("narrows correctly when discuss follows plan", async () => {
		const pi = await boot();

		await pi.runCommand("mode", "plan");
		await pi.runCommand("mode", "discuss");
		expect(active(pi).has("edit")).toBe(false);

		await pi.runCommand("mode", "build");
		expect(active(pi).has("edit")).toBe(true);
	});

	it("keeps the read-only MCP card gateway visible in discussion mode", async () => {
		// Which cards are reviewed comes from the house profile; the gateway's own
		// behaviour is what this pins.
		setHouseProfileForTest({ readOnlyMcpTools: ["alpha_read_chart"] });
		const pi = await boot();

		await pi.runCommand("mode", "discuss");
		expect(active(pi).has("mcp")).toBe(true);
		expect(active(pi).has("render_chart")).toBe(true);
		expect(active(pi).has("mcpScript")).toBe(false);

		const safe = await pi.emit({
			type: "tool_call",
			toolName: "mcp",
			input: { tool: "alpha_read_chart", args: { hours: 24 } },
		});
		expect(safe.some((result) => (result as { block?: boolean } | undefined)?.block)).toBe(false);

		const blocked = await pi.emit({
			type: "tool_call",
			toolName: "mcp",
			input: { tool: "alpha_start_trading", args: {} },
		});
		expect(blocked.some((result) => (result as { block?: boolean } | undefined)?.block)).toBe(true);
	});
});

describe("the two extensions agree about the plan posture", () => {
	// The hole PLAN_MODE_STATE_CHANNEL closes: without the feedback, opmode would
	// keep reporting `plan` — and the Hive workspace would keep showing a
	// read-only session — after the enforcement had been switched off.
	it("drops opmode out of plan when /plan exit turns the gate off", async () => {
		const pi = await boot();

		await pi.runCommand("mode", "plan");
		await pi.runCommand("plan", "exit");

		const reported = pi.busEvents.filter((e) => e.name === "hive.opmode.state");
		expect((reported.at(-1)?.payload as { mode?: string })?.mode).toBe("build");
	});

	it("moves opmode into plan when /plan is typed directly", async () => {
		const pi = await boot();

		await pi.runCommand("plan", "start");

		const reported = pi.busEvents.filter((e) => e.name === "hive.opmode.state");
		expect((reported.at(-1)?.payload as { mode?: string })?.mode).toBe("plan");
	});
});
