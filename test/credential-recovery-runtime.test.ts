import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import credentialRecovery from "../extensions/credential-recovery/index.ts";

it("the native Pi loop switches credentials mid-task without executing the completed tool twice", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-quota-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const provider = "hive-recovery-test";
	const authPath = join(dir, "auth.json");
	await writeFile(authPath, JSON.stringify({ [provider]: { type: "api_key", key: "account-a" } }));
	const broker = createServer(async (req, res) => {
		for await (const _chunk of req) { /* consume the bounded request */ }
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ [provider]: { type: "api_key", key: "account-b" } }));
	});
	await new Promise<void>((resolve) => broker.listen(authPath + ".hive-recovery.sock", resolve));
	let writes = 0;
	let calls = 0;
	const keys: (string | undefined)[] = [];
	const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider(provider, {
		api: "openai-completions", baseUrl: "https://example.invalid",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model, _context, options) {
			keys.push(options?.apiKey);
			calls++;
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider, model: model.id, timestamp: Date.now(),
				content: calls === 1 ? [{ type: "toolCall", id: "write-once", name: "fixture_write", arguments: {} }] : calls === 2 ? [] : [{ type: "text", text: "finished" }],
				stopReason: calls === 1 ? "toolUse" : calls === 2 ? "error" : "stop",
				...(calls === 2 ? { errorMessage: "quota exceeded" } : {}),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
			else if (message.stopReason === "stop" || message.stopReason === "toolUse") stream.push({ type: "done", reason: message.stopReason, message });
			else throw new Error("Unexpected fixture stop reason");
			stream.end(message);
			return stream;
		},
	});
	const model = runtime.getModel(provider, "test");
	if (!model) throw new Error("Fixture model was not registered");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [credentialRecovery] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), tools: ["fixture_write"], customTools: [{
		name: "fixture_write", label: "fixture write", description: "Record one completed write", parameters: Type.Object({}),
		async execute() { writes++; return { content: [{ type: "text", text: "saved" }], details: {} }; },
	}] });
	try {
		await session.bindExtensions({ mode: "print" });
		await session.prompt("Complete the task, preserving completed actions.");
		expect(writes).toBe(1);
		expect(calls).toBe(3);
		expect(keys).toEqual(["account-a", "account-a", "account-b"]);
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	} finally {
		session.dispose();
		await new Promise<void>((resolve, reject) => broker.close((error) => error ? reject(error) : resolve()));
		await rm(dir, { recursive: true });
		vi.unstubAllEnvs();
	}
}, 15000);
