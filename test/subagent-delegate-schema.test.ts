/**
 * The schema path through `delegate.ts` after the lift: the caller's schema
 * travels with pi's validator (`StructuredRequest`), the instruction reaches
 * the worker's appended system prompt, and the answer is validated — with a
 * real worker spawn (a fake pi), not just the pure functions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as structuredSupport from "../extensions/harness/structured.ts";
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

	it("without a request, the worker sees no schema instruction", async () => {
		const outcome = await runSingleDelegation({ agent: "research", task: "count things", model: "zai/glm-low" }, "off", host());
		expect(outcome.results[0].structured).toBeUndefined();
		expect(launch.calls()[0].input).not.toContain("Required output format");
	});
});
