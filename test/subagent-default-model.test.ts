import { afterEach, describe, expect, it } from "vitest";
import { getSubagentDefaultModel } from "../extensions/subagent/index.ts";

const original = process.env.PI_SUBAGENT_MODEL;

afterEach(() => {
	if (original === undefined) delete process.env.PI_SUBAGENT_MODEL;
	else process.env.PI_SUBAGENT_MODEL = original;
});

describe("subagent default model", () => {
	it("takes PI_SUBAGENT_MODEL over the workstation settings", () => {
		process.env.PI_SUBAGENT_MODEL = "openrouter/openai/gpt-5.6-luna";
		expect(getSubagentDefaultModel()).toBe("openrouter/openai/gpt-5.6-luna");
	});

	it("reads the env on every call rather than through the settings cache", () => {
		process.env.PI_SUBAGENT_MODEL = "openrouter/z-ai/glm-5.2";
		expect(getSubagentDefaultModel()).toBe("openrouter/z-ai/glm-5.2");
		process.env.PI_SUBAGENT_MODEL = "openrouter/deepseek/deepseek-v4-flash";
		expect(getSubagentDefaultModel()).toBe("openrouter/deepseek/deepseek-v4-flash");
	});

	// An empty or whitespace-only value is an unset variable, not a model name.
	// A launcher that computes the model and finds none must not pin the child
	// to "" — the child would then be spawned with `--model ""`.
	it("ignores a blank value instead of passing it through", () => {
		process.env.PI_SUBAGENT_MODEL = "   ";
		expect(getSubagentDefaultModel()).not.toBe("   ");
		expect(getSubagentDefaultModel()).not.toBe("");
	});
});
