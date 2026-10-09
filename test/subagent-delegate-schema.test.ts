/**
 * The schema path through `delegate.ts` after the lift: the caller's schema
 * travels with pi's validator (`StructuredRequest`), the instruction reaches
 * the worker's appended system prompt, and the answer is validated — with a
 * real worker spawn (a fake pi), not just the pure functions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as structuredSupport from "../extensions/harness/structured.ts";
import subagentExtension from "../extensions/subagent/index.ts";
import { createFakePi } from "./fake-pi.ts";
import { runSingleDelegation, type DelegationHost } from "../extensions/subagent/delegate.ts";
import { makeLaunch, type LaunchEnv } from "./claude-harness.ts";

let launch: LaunchEnv;
let previous: string | undefined;

beforeEach(() => {
	launch = makeLaunch();
	previous = process.env.PI_HOUSE_PI_BIN;
	process.env.PI_HOUSE_PI_BIN = launch.piBin;
});
afterEach(() => {
	if (previous === undefined) delete process.env.PI_HOUSE_PI_BIN;
	else process.env.PI_HOUSE_PI_BIN = previous;
});

const host = (): DelegationHost => ({
	cwd: launch.root,
	agents: [{ name: "research", description: "r", tools: ["read"], systemPrompt: "Be brief.", source: "package", filePath: "" }],
	modelEnv: { isConfigured: () => true, catalog: async () => [] },
	signal: undefined,
	makeDetails: (mode) => (results) => ({ mode, agentScope: "user", projectAgentsDir: null, results }),
});

describe("delegate.ts schema requests", () => {
	it("appends the schema instruction and returns the validated object", async () => {
		launch.setReplies([{ match: "Required output format", text: 'Counted.\n```json\n{"count": 3}\n```' }]);
		const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
		const outcome = await runSingleDelegation(
			{ agent: "research", task: "count things", model: "zai/glm-low", schema: { schema, support: structuredSupport } },
			"off",
			host(),
		);
		expect(outcome.isError).toBeUndefined();
		expect(outcome.results[0].structured).toEqual({ count: 3 });
		expect(outcome.text).toContain("Structured result (validated against your schema)");
		expect(launch.calls()[0].input).toContain("Required output format");
	});

	it("keeps schema-retry feedback for neutral code review, without the author's framing", async () => {
		launch.setReplies([
			{ match: "A previous attempt at this exact task", text: '```json\n{"count": 2}\n```' },
			{ match: "Required output format", text: '```json\n{"count": "wrong"}\n```' },
		]);
		const h = host(); h.agents[0] = { ...h.agents[0], name: "code-reviewer" };
		const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
		const outcome = await runSingleDelegation({ agent: "code-reviewer", task: "Review /tmp/example.ts; my design is safe", model: "zai/glm-low", schema: { schema, support: structuredSupport } }, "off", h);
		expect(outcome.results[0].structured).toEqual({ count: 2 });
		expect(launch.calls()).toHaveLength(2);
		for (const call of launch.calls()) { expect(call.input).toContain("/tmp/example.ts"); expect(call.input).not.toContain("my design is safe"); }
		expect(launch.calls()[1].input).toContain("A previous attempt at this exact task");
	});
	it("without a request, the worker sees no schema instruction", async () => {
		const outcome = await runSingleDelegation({ agent: "research", task: "count things", model: "zai/glm-low" }, "off", host());
		expect(outcome.results[0].structured).toBeUndefined();
		expect(launch.calls()[0].input).not.toContain("Required output format");
	});
});

describe("the pi subagent tool's schema wiring", () => {
	function run(params: Record<string, unknown>) {
		const pi = createFakePi();
		for (const name of ["read", "grep", "find", "ls", "knowledge_search", "knowledge_grep", "knowledge_get", "knowledge_multi_get", "knowledge_collections"]) {
			pi.api.registerTool({ name, label: name, description: name, parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [], details: {} }) } as never);
		}
		subagentExtension(pi.api);
		const tool = pi.tools.find((entry) => entry.name === "subagent")?.definition as {
			execute: (...args: unknown[]) => Promise<{ content?: { text?: string }[]; isError?: boolean }>;
		};
		const ctx = {
			mode: "tui",
			cwd: launch.root,
			isProjectTrusted: () => false,
			hasUI: false,
			modelRegistry: { find: () => ({}), isUsingOAuth: () => false },
			model: { provider: "zai", id: "glm-low" },
			sessionManager: { getSessionId: () => "s", getBranch: () => [] },
		};
		return tool.execute("cid", { agent: "research", task: "count things", model: "zai/glm-low", verify: "off", ...params }, undefined, undefined, ctx);
	}

	it("treats `schema: null` as no schema — the worker sees no schema instruction", async () => {
		const result = await run({ schema: null });
		expect(result.isError).toBeFalsy();
		expect(launch.calls()).toHaveLength(1);
		expect(launch.calls()[0].input).not.toContain("Required output format");
	});

	it("pairs a real schema with pi's validator", async () => {
		launch.setReplies([{ match: "Required output format", text: '```json\n{"count": 2}\n```' }]);
		const result = await run({ schema: { type: "object", properties: { count: { type: "number" } } } });
		expect(result.content?.[0]?.text).toContain("Structured result (validated against your schema)");
	});
});
