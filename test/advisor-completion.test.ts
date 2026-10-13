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

describe("advisor transcript", () => {
	it("forwards team-message, handback and agenda custom messages, labelled", async () => {
		vi.spyOn(config, "loadAdvisorConfig").mockReturnValue({ disabled: false, modelOverride: "openai-codex/reviewer", timeoutMs: 1000, maxChars: 100_000 });
		const registerTool = vi.fn();
		advisor({ registerTool } as unknown as ExtensionAPI);
		const tool = registerTool.mock.calls[0][0] as ToolDefinition;
		const response = { content: [{ type: "text", text: "reviewed" }], usage: { input: 1, output: 1 } };
		const streamSimple = vi.fn().mockReturnValue({ result: async () => response });
		const model = { provider: "openai-codex", id: "reviewer" };
		const at = "2026-10-12T10:00:00.000Z";
		const entries = [
			{ type: "message", message: { role: "user", content: "do the task", timestamp: 1 } },
			{ type: "custom_message", customType: "team-message", content: "RESUME bounded READ-ONLY review", display: true, timestamp: at },
			{ type: "custom_message", customType: "handback", content: [{ type: "text", text: "handback pending" }], display: true, timestamp: at },
			{ type: "custom_message", customType: "agenda", content: "Conductor: stay on scope", display: true, timestamp: at },
			{ type: "custom", customType: "state-only", data: {} },
		];
		const ctx = {
			model: { ...model, id: "caller" },
			sessionManager: { buildContextEntries: () => entries },
			modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "t" }), streamSimple },
		} as unknown as ExtensionToolContext;
		await tool.execute("call", {}, undefined, undefined, ctx);
		const sent = JSON.stringify(streamSimple.mock.calls[0][1]);
		expect(sent).toContain("[team-message message delivered to the session]");
		expect(sent).toContain("RESUME bounded READ-ONLY review");
		expect(sent).toContain("handback pending");
		expect(sent).toContain("Conductor: stay on scope");
		expect(sent).not.toContain("state-only");
	});
});
