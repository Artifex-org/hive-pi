/**
 * The `model` parameter at the CALL SITE — the registered tool, not the pure
 * chooser. `test/subagent-background.test.ts` names the trap this exists for:
 * a schema field that typechecks and is wired to nothing.
 *
 * Every case here is refused BEFORE a worker exists (an unconfigured explicit
 * model is a pre-spawn refusal), so nothing spawns a pi child.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import subagentExtension from "../extensions/subagent/index.ts";
import { discoverAgents } from "../extensions/harness/roles.ts";

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hive-pi-model-param-"));
});

const ROLE = "research";

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

/** A registry that knows NOTHING — every explicit model is unconfigured here. */
const ctx = {
	mode: "tui",
	cwd: process.cwd(),
	isProjectTrusted: () => true,
	hasUI: false,
	modelRegistry: { find: () => undefined, isUsingOAuth: () => false },
	model: { provider: "openai-codex", id: "gpt-5.6-terra" },
};

describe("the `model` parameter the model can see", () => {
	it("is exposed in single mode and per task / chain item", () => {
		const properties = subagentTool(boot()).parameters.properties ?? {};
		expect(Object.keys(properties)).toContain("model");
		const items = (properties.tasks as { items?: { properties?: Record<string, unknown> } })?.items?.properties ?? {};
		expect(Object.keys(items)).toContain("model");
		const chain = (properties.chain as { items?: { properties?: Record<string, unknown> } })?.items?.properties ?? {};
		expect(Object.keys(chain)).toContain("model");
	});

	it("refuses an unconfigured explicit model before any worker exists (single mode)", async () => {
		const result = await subagentTool(boot()).execute(
			"cid",
			{ agent: ROLE, task: "look", model: "nope/x" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("model nope/x is not configured");
		expect(result.content?.[0]?.text).toContain("no worker was started");
	});

	it("refuses it per task in parallel mode, naming the task's role", async () => {
		const result = await subagentTool(boot()).execute(
			"cid",
			{ tasks: [{ agent: ROLE, task: "look", model: "nope/x" }] },
			undefined,
			undefined,
			ctx,
		);
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain("0/1 succeeded");
		expect(text).toContain("model nope/x is not configured");
	});
});
