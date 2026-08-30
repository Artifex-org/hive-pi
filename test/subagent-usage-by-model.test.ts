import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { subagentToolUsage, subagentUsageByModel, type SingleResult } from "../extensions/subagent/index.ts";

function assistant(
	provider: string,
	model: string,
	responseModel: string | undefined,
	input: number,
	output: number,
	cost: number,
): AssistantMessage {
	return {
		role: "assistant",
		provider,
		model,
		responseModel,
		usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
	} as AssistantMessage;
}

function result(messages: AssistantMessage[]): Pick<SingleResult, "messages"> {
	return { messages };
}

describe("subagentUsageByModel", () => {
	it("emits only child response-model metrics and registry-derived auth", () => {
		const usage = subagentUsageByModel(
			[
				result([
					assistant("zai", "glm-5.3-flash", undefined, 1000, 100, 0.01),
					assistant("openrouter", "auto", "deepseek/deepseek-v4-flash", 500, 50, 0.02),
				]),
			],
			(provider) => (provider === "zai" ? "subscription" : "api_key"),
		);

		expect(usage).toEqual([
			{ provider: "zai", model: "glm-5.3-flash", authMode: "subscription", turns: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
			{ provider: "openrouter", model: "deepseek/deepseek-v4-flash", authMode: "api_key", turns: 1, input: 500, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
		]);
	});

	it("leaves unresolvable child authentication unknown", () => {
		const usage = subagentUsageByModel(
			[result([assistant("unconfigured", "model", undefined, 1000, 100, 0.01)])],
			() => "unknown",
		);

		expect(usage[0]?.authMode).toBe("unknown");
	});

	it("returns the matching aggregate to Pi's tool-result usage channel", () => {
		const aggregate = subagentToolUsage([
			{ provider: "zai", model: "glm-5.3-flash", authMode: "subscription", turns: 2, input: 4500, output: 350, cacheRead: 0, cacheWrite: 0, cost: 0.04 },
			{ provider: "openrouter", model: "deepseek/deepseek-v4-flash", authMode: "api_key", turns: 1, input: 500, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
		]);

		expect(aggregate).toMatchObject({ input: 5000, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } });
	});
});
