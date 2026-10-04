import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import advisor from "../extensions/advisor/index.ts";
import * as config from "../extensions/advisor/config.ts";
import * as identity from "../extensions/hive-common/identity.ts";
import * as modes from "../extensions/advisor/modes.ts";

afterEach(() => vi.restoreAllMocks());

describe("advisor completion", () => {
	it.each([
		["high", "high", undefined],
		["xhigh", "xhigh", undefined],
		["off", undefined, undefined],
		[undefined, "high", undefined],
		["invalid", "high", undefined],
		[undefined, "high", "openai-codex/reviewer"],
	])("passes thinking %s as %s (override %s)", async (thinking, expected, modelOverride) => {
		vi.spyOn(config, "loadAdvisorConfig").mockReturnValue({ disabled: false, modelOverride, timeoutMs: 1000, maxChars: 1000 });
		vi.spyOn(identity, "resolveAuth").mockReturnValue({ token: "t", url: "https://hive.example", source: "test" });
		vi.spyOn(modes, "fetchAgentModeOutcome").mockResolvedValue({
			kind: "ok", catalog: { subagentKey: undefined, modes: [{ key: "high", model: "openai-codex/reviewer", thinking }] },
		});
		const registerTool = vi.fn();
		advisor({ registerTool } as unknown as ExtensionAPI);
		const tool = registerTool.mock.calls[0][0] as ToolDefinition;
		const response = { content: [{ type: "text", text: "reviewed" }], usage: { input: 1, output: 1 } };
		const complete = vi.fn().mockResolvedValue(response);
		const streamSimple = vi.fn().mockReturnValue({ result: async () => response });
		const model = { provider: "openai-codex", id: "reviewer" };
		const ctx = {
			model: { ...model, id: "caller" },
			sessionManager: { buildContextEntries: () => [] },
			modelRegistry: {
				find: () => model,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "t" }),
				complete, streamSimple,
			},
		} as unknown as ExtensionToolContext;
		const result = await tool.execute("call", {}, undefined, undefined, ctx);
		expect(result.content).toEqual([{ type: "text", text: "reviewed" }]);
		expect(streamSimple).toHaveBeenCalledWith(model, expect.any(Object), expect.objectContaining({ reasoning: expected }));
		expect(complete).not.toHaveBeenCalled();
	});
});
