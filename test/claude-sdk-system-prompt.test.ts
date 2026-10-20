import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkRuntime, sdkSystemPrompt, type QueryFactory } from "../extensions/claude-sdk/provider.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const lease = async () => ({ access_token: "synthetic-access-only", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "account-a", slot: "slot-a" });
const event = (value: unknown): SDKMessage => ({ type: "stream_event", event: value, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-000000000001", session_id: "fixture" }) as unknown as SDKMessage;
function* reply() {
	yield event({ type: "message_start", message: { id: "response", usage: { input_tokens: 1, output_tokens: 0 } } });
	yield event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	yield event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
	yield event({ type: "content_block_stop", index: 0 });
	yield event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
	yield event({ type: "message_stop" });
	yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
}

describe("Claude SDK system prompt", () => {
	it("sends Pi's real default prompt without its docs section", async () => {
		const root = await mkdtemp(join(tmpdir(), "claude-sdk-prompt-"));
		cleanups.push(() => rm(root, { force: true, recursive: true }));
		const sent: Options[] = [];
		const query: QueryFactory = request => {
			const iterator = (async function* () {
				await request.prompt[Symbol.asyncIterator]().next(); sent.push(request.options);
				yield* reply();
			})();
			return { [Symbol.asyncIterator]: () => iterator, close() {} };
		};
		const sdk = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, url: "https://hive.invalid", token: "synthetic-hive",
			launch: "launch-offline", cwd: process.cwd() }, { query, lease, validateExecutable: async () => {} });
		cleanups.push(sdk.close);
		const model = sdk.provider.getModels().find(m => m.id.includes("sonnet"))!;
		const modelRuntime = await ModelRuntime.create({ authPath: join(root, "pi-auth.json"), modelsPath: null,
			modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
		modelRuntime.registerNativeProvider(sdk.provider);
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, settingsManager: settings,
			resourceLoader: loader, tools: ["read"], sessionManager: SessionManager.inMemory(root) });
		cleanups.push(async () => { session.dispose(); });

		await session.prompt("reply with the word ok");

		expect(session.getLastAssistantText()).toBe("ok");
		const prompt = String(sent[0].systemPrompt);
		expect(prompt).toContain("operating inside pi, a coding agent harness");
		expect(prompt).toContain("<cwd>");
		expect(prompt).not.toContain("<docs>");
		expect(prompt).not.toContain("docs/custom-provider.md");
		expect(prompt).not.toContain("docs/packages.md");
	});

	it("keeps every other section verbatim and in order", () => {
		const system: SystemMessage = { role: "system", content: "Preamble", timestamp: 0,
			sections: { tools: "<tools>\nT\n</tools>", docs: "<docs>\nD\n</docs>", project_context: "<project_context>\nP\n</project_context>" } };
		const forced: SystemMessage = { role: "system", content: "Forced prompt", timestamp: 0 };
		expect(sdkSystemPrompt([system])).toBe("Preamble\n\n<tools>\nT\n</tools>\n\n<project_context>\nP\n</project_context>");
		expect(sdkSystemPrompt([forced])).toBe("Forced prompt");
		expect(sdkSystemPrompt([])).toBe("");
	});
});
