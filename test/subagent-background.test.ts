/**
 * The subagent tool's background path, as actually registered.
 *
 * `test/background-delegation.test.ts` covers the rules and the bus. This
 * covers the thing neither of those can see: that the tool the model calls
 * really carries the parameters, really refuses before spawning, and really
 * announces the job on the bus. A schema field that exists but is wired to
 * nothing typechecks perfectly and does nothing at all — the exact silent gap
 * this harness keeps finding in itself.
 *
 * ## What these tests actually do to the machine
 *
 * An earlier version of this header claimed they "stop short of running a
 * worker". They do not: the two well-formed cases call the real
 * `runSingleAgent`, which really does spawn a pi child. That is fine and even
 * desirable — it is what proves the call RETURNS while the worker is still
 * starting — but it has to be said out loud, because it means these tests
 * depend on the environment and reap through the `session_shutdown` emit at the
 * end of each one.
 *
 * Nothing here asserts anything about the worker's RESULT. A cold pi child
 * spends 25-45s compiling extensions before its first model turn and needs a
 * provider credential, so waiting for one would be slow, flaky, and would spend
 * money in CI. Where the child cannot start at all — no pi binary, no
 * credential — the spawn simply fails and the delegation reports a failure
 * through the bus, which is a path worth exercising too. Everything asserted
 * here happens BEFORE the child's outcome matters.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import subagentExtension from "../extensions/subagent/index.ts";
import { discoverAgents } from "../extensions/harness/roles.ts";
import { BACKGROUND_JOB_CHANNEL } from "../extensions/background/channel.ts";
import { MAX_CONCURRENT } from "../extensions/background/jobs.ts";

beforeAll(() => {
	// Same isolation as the other subagent suites: ~/.pi/agent/agents is a
	// symlink to these very files on a developer's machine.
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hive-pi-bg-subagent-"));
});

/**
 * The role used throughout. Read-only, so nothing here can take a writer lock.
 */
const ROLE = "research";

/**
 * Boot the extension with the roles' declared tools present in the registry.
 *
 * The tool-universe check (wave 5) refuses any role naming a tool this session
 * cannot provide, and it runs before the background path — correctly, since a
 * role that would run without half its tools must be refused whether or not it
 * is backgrounded. The fake pi registers almost nothing, so without these stubs
 * every case here fails on that check instead of on what it is testing.
 *
 * The stub set is DERIVED from the role rather than written out, so editing a
 * role's `tools:` line cannot silently turn these tests back into
 * tool-universe assertions.
 */
function boot(): FakePi {
	const pi = createFakePi();
	const role = discoverAgents(process.cwd(), "user").agents.find((agent) => agent.name === ROLE);
	for (const name of role?.tools ?? []) {
		pi.api.registerTool({
			name,
			label: name,
			description: `stub ${name}`,
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
		} as never);
	}
	subagentExtension(pi.api);
	return pi;
}

function subagentTool(pi: FakePi) {
	const tool = pi.tools.find((entry) => entry.name === "subagent");
	if (!tool) throw new Error("no subagent tool registered");
	return tool.definition as {
		parameters: { properties?: Record<string, unknown> };
		execute: (...args: unknown[]) => Promise<{ content?: { text?: string }[]; isError?: boolean }>;
	};
}

describe("the parameters the model can actually see", () => {
	it("exposes background and what", () => {
		const properties = subagentTool(boot()).parameters.properties ?? {};
		expect(Object.keys(properties)).toContain("background");
		expect(Object.keys(properties)).toContain("what");
	});

	it("documents that backgrounding is single mode only", () => {
		const properties = subagentTool(boot()).parameters.properties ?? {};
		const description = (properties.background as { description?: string })?.description ?? "";
		expect(description).toContain("Single mode only");
	});
});

describe("refusals happen BEFORE anything is spawned", () => {
	it("refuses in headless mode and announces nothing on the bus", async () => {
		const pi = boot();
		const result = await subagentTool(pi).execute(
			"cid",
			{ background: true, what: "auditing", agent: ROLE, task: "look" },
			undefined,
			undefined,
			{ mode: "headless", cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false },
		);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("headless");
		expect(pi.busEvents.filter((event) => event.name === BACKGROUND_JOB_CHANNEL)).toHaveLength(0);
	});

	it("refuses a background chain, and does not start it either", async () => {
		const pi = boot();
		const result = await subagentTool(pi).execute(
			"cid",
			{ background: true, what: "auditing", chain: [{ agent: ROLE, task: "look" }] },
			undefined,
			undefined,
			{ mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false },
		);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("single mode only");
		expect(pi.busEvents.filter((event) => event.name === BACKGROUND_JOB_CHANNEL)).toHaveLength(0);
	});

	it("refuses a missing `what` before spawning, not after", async () => {
		const pi = boot();
		const result = await subagentTool(pi).execute(
			"cid",
			{ background: true, agent: ROLE, task: "look" },
			undefined,
			undefined,
			{ mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false },
		);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("`what`");
		expect(pi.busEvents.filter((event) => event.name === BACKGROUND_JOB_CHANNEL)).toHaveLength(0);
	});

	it("refuses an unknown role before backgrounding it", async () => {
		// Otherwise the refusal would arrive as a completion notification later,
		// for a job the model was told had started.
		const pi = boot();
		const result = await subagentTool(pi).execute(
			"cid",
			{ background: true, what: "auditing", agent: "no-such-role", task: "look" },
			undefined,
			undefined,
			{ mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false },
		);
		const starts = pi.busEvents.filter(
			(event) => event.name === BACKGROUND_JOB_CHANNEL && (event.payload as { action?: string }).action === "start",
		);
		// Either it refused outright, or it announced a job — never both, and
		// never a started job for a role that does not exist.
		if (starts.length > 0) {
			throw new Error("announced a background job for an unknown role");
		}
		expect(result.content?.[0]?.text).toContain("no-such-role");
	});
});

describe("a well-formed background delegation", () => {
	it("announces the job on the bus and returns without waiting", async () => {
		const pi = boot();
		const started = Date.now();
		const result = await subagentTool(pi).execute(
			"cid",
			{ background: true, what: "auditing the migration", agent: ROLE, task: "look at it" },
			undefined,
			undefined,
			{ mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false },
		);
		const elapsed = Date.now() - started;

		// The whole feature: the call returns while the worker is still starting.
		// A cold pi child takes 25-45s just to compile its extensions.
		expect(elapsed).toBeLessThan(5_000);
		expect(result.isError).toBeFalsy();
		expect(result.content?.[0]?.text).toContain("Do NOT poll");

		const starts = pi.busEvents.filter(
			(event) => event.name === BACKGROUND_JOB_CHANNEL && (event.payload as { action?: string }).action === "start",
		);
		expect(starts).toHaveLength(1);
		const payload = starts[0].payload as { id?: string; what?: string; kind?: string };
		expect(payload.kind).toBe("subagent");
		expect(payload.what).toBe("auditing the migration");
		// Namespaced away from the background extension's own `bg-N`, or
		// `background_result` would return whichever job registered last.
		expect(payload.id).toMatch(/^sub-\d+$/);

		// Reap the worker this started so it cannot outlive the suite.
		await pi.emit({ type: "session_shutdown" }, { mode: "tui" });
	});

	it("caps concurrent delegations — each one is a real pi child", async () => {
		// The cap has to exist separately on this side: MAX_CONCURRENT guards the
		// background extension's shell jobs, and jiti isolation means the two
		// counters cannot see each other. Unbounded, this path is the fork bomb
		// the constant's own comment warns about.
		const pi = boot();
		const ctx = { mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false };
		const params = { background: true, what: "auditing", agent: ROLE, task: "look" };
		for (let i = 0; i < MAX_CONCURRENT; i += 1) {
			await subagentTool(pi).execute(`c${i}`, params, undefined, undefined, ctx);
		}
		const refused = await subagentTool(pi).execute("over", params, undefined, undefined, ctx);
		expect(refused.isError).toBe(true);
		expect(refused.content?.[0]?.text).toContain("the limit");

		const starts = pi.busEvents.filter(
			(event) => event.name === BACKGROUND_JOB_CHANNEL && (event.payload as { action?: string }).action === "start",
		);
		expect(starts).toHaveLength(MAX_CONCURRENT);

		await pi.emit({ type: "session_shutdown" }, { mode: "tui" });
	});

	it("mints a fresh id per delegation", async () => {
		const pi = boot();
		const ctx = { mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false };
		const params = { background: true, what: "auditing", agent: ROLE, task: "look" };
		await subagentTool(pi).execute("c1", params, undefined, undefined, ctx);
		await subagentTool(pi).execute("c2", params, undefined, undefined, ctx);

		const ids = pi.busEvents
			.filter((event) => event.name === BACKGROUND_JOB_CHANNEL && (event.payload as { action?: string }).action === "start")
			.map((event) => (event.payload as { id?: string }).id);
		expect(new Set(ids).size).toBe(2);

		await pi.emit({ type: "session_shutdown" }, { mode: "tui" });
	});
});
