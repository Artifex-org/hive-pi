/** The actual pi loader/runner, reload and nested-tool paths; no network model requests. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import opmode from "../extensions/opmode/index.ts";
import plan from "../extensions/plan/index.ts";

it("real codemode executes a reviewed read but blocks a write before its handler runs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plan-codemode-runtime-"));
	const provider = "plan-codemode-test";
	await writeFile(join(dir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "test-key" } }));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	let modelCalls = 0, reads = 0, writes = 0;
	const nestedCalls: string[] = [];
	runtime.registerProvider(provider, {
		api: "openai-completions", baseUrl: "https://example.invalid",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model) {
			const first = ++modelCalls === 1;
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider, model: model.id, timestamp: Date.now(),
				content: first ? [{ type: "toolCall", id: "research", name: "codemode", arguments: { code: `
					text(await tools.mcp__hive__get_run({}));
					const [write] = await Promise.allSettled([tools.mcp__hive__knowledge_write({})]);
					text(write.status);
					if (write.status === "rejected") text(String(write.reason));
				` } }] : [{ type: "text", text: "finished" }],
				stopReason: first ? "toolUse" : "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
			stream.end(message);
			return stream;
		},
	});
	const model = runtime.getModel(provider, "test");
	if (!model) throw new Error("Fixture model was not registered");
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [pi => { pi.on("tool_call", event => { if (event.parentToolCallId) nestedCalls.push(event.toolName); }); }, createCodemodeExtension({ models: false }), opmode, plan],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(), customTools: [
			{ name: "mcp__hive__get_run", label: "read", description: "fixture read", exposure: "codemode", parameters: Type.Object({}),
				async execute() { reads++; return { content: [{ type: "text", text: "live-read" }], details: {} }; } },
			{ name: "mcp__hive__knowledge_write", label: "write", description: "fixture write", exposure: "codemode", parameters: Type.Object({}),
				async execute() { writes++; return { content: [{ type: "text", text: "mutated" }], details: {} }; } },
		],
	});
	try {
		expect(extensionsResult.errors).toEqual([]);
		extensionsResult.runtime.flagValues.set("op-mode", "plan");
		await session.bindExtensions({ mode: "print" });
		await session.prompt("Research the run without changing it.");
		expect(modelCalls).toBe(2);
		expect(reads).toBe(1);
		expect(writes).toBe(0);
		expect(nestedCalls).toEqual(["mcp__hive__get_run", "mcp__hive__knowledge_write"]);
		const result = session.messages.find(message => message.role === "toolResult");
		expect(JSON.stringify(result)).toContain("live-read");
		expect(JSON.stringify(result)).toContain("rejected");
		expect(JSON.stringify(result)).toContain("not on plan mode's read-only allowlist");
	} finally {
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});

it.each([false, true])("enforces launch flags through real rebind/reload and restores editors (planFirst=%s)", async planFirst => {
	const dir = await mkdtemp(join(tmpdir(), "plan-runtime-"));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const model = runtime.getModels()[0];
	if (!model) throw new Error("No built-in model in fixture runtime");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: planFirst ? [plan, opmode] : [opmode, plan],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(),
	});
	try {
		expect(extensionsResult.errors).toEqual([]);
		extensionsResult.runtime.flagValues.set("op-mode", "plan");
		const denied = () => session.extensionRunner.emitToolCall({
			type: "tool_call", toolCallId: "write-test", toolName: "write", input: { path: "new.ts", content: "x" },
		});
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
		expect(await denied()).toMatchObject({ block: true });
		await session.bindExtensions({ mode: "print" });
		expect(await denied()).toMatchObject({ block: true });
		const oldRunner = session.extensionRunner;
		const sessionId = session.sessionManager.getSessionId();
		// Reload WHILE restricted: the old runtime must not carry a narrowed
		// snapshot into the new plan owner's eventual restoration baseline.
		await session.reload();
		expect(session.extensionRunner).not.toBe(oldRunner);
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(session.extensionRunner.getFlagValues().get("op-mode")).toBe("plan");
		expect(await denied()).toMatchObject({ block: true });
		expect(session.getActiveToolNames()).not.toContain("write");
		await session.prompt("/plan exit");
		expect((await denied())?.block).not.toBe(true);
		for (const name of ["read", "bash", "write", "edit"]) expect(session.getActiveToolNames()).toContain(name);
		expect(errors).toEqual([]);
	} finally {
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
