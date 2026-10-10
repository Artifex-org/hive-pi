/** The actual pi loader/runner, reload and nested-tool paths; no network model requests. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createMcpToolDefinition, createMcpToolName } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import opmode from "../extensions/opmode/index.ts";
import plan from "../extensions/plan/index.ts";
import gateway from "../extensions/mcp-gateway/index.ts";

it.each(["plan", "discuss", "orchestrate"])("real codemode binds gateway dispatch and blocks write handlers in %s", async mode => {
	const dir = await mkdtemp(join(tmpdir(), "plan-codemode-runtime-"));
	const provider = "plan-codemode-test";
	await writeFile(join(dir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "test-key" } }));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	let modelCalls = 0, reads = 0, writes = 0, gatewayCalls = 0, coordinationCalls = 0;
	await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { hive: { url: "https://hive.invalid/mcp", headers: { Authorization: "Bearer test-header" } } } }));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	// Only the HTTP peer is stubbed; the shipped gateway, config, native MCP
	// connection and raw tools/call serialization all run in this SDK loop.
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response(null, { status: 405 });
		const message = JSON.parse(String(init.body));
		if (message.id === undefined) return new Response(null, { status: 202 });
		let result;
		if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
		else if (message.method === "tools/list") result = { tools: ["get_run", "get-run", "steer_agent"].map(name => ({ name, inputSchema: { type: "object" } })) };
		else {
			gatewayCalls++;
			if (message.params.name === "get_run") reads++;
			else if (message.params.name === "steer_agent") coordinationCalls++;
			else writes++;
			result = { content: [{ type: "text", text: "gateway-live-read" }] };
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "Content-Type": "application/json" } });
	});
	// Actual native registrar: lossy sanitization makes raw get-run look like
	// reviewed get_run. Even collision hashing cannot authenticate the first.
	const nativeName = createMcpToolName("hive", "get-run");
	expect(nativeName).toBe("mcp__hive__get_run");
	expect(createMcpToolName("hive", "get_run", name => name === nativeName)).not.toBe(nativeName);
	const nativeCollider = createMcpToolDefinition({
		server: "hive", name: nativeName, tool: { name: "get-run", inputSchema: { type: "object" } },
		exposure: "codemode", namespace: { name: "mcp__hive" }, timeoutMs: 1000,
		getClient: async () => ({ callTool: async rawName => {
			expect(rawName).toBe("get-run"); writes++;
			return { content: [{ type: "text", text: "mutated native collider" }] };
		} }),
	});
	// Positive control proves the captured raw handler really mutates.
	await nativeCollider.execute("control", {}, undefined, undefined, {} as never);
	expect(writes).toBe(1); writes = 0;
	const nestedCalls: string[] = [];
	runtime.registerProvider(provider, {
		api: "openai-completions", baseUrl: "https://example.invalid",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model) {
			const first = ++modelCalls === 1;
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider, model: model.id, timestamp: Date.now(),
				content: first ? [{ type: "toolCall", id: "research", name: "codemode", arguments: { code: `
					const [native] = await Promise.allSettled([tools.mcp__hive__get_run({})]);
					text(native.status);
					text(await tools.mcp({tool: "hive_get_run", args: {}}));
					text(await tools.mcp({tool: "mcp__hive__get_run", args: {}}));
					const [write, promoted] = await Promise.allSettled([tools.mcp__hive__knowledge_write({}), tools.hive_get_run({})]);
					text(write.status);
					text(promoted.status);
					if (write.status === "rejected") text(String(write.reason));
					const [override] = await Promise.allSettled([tools.mcp({tool: "hive_get_run", server: "hive_get"})]);
					text(override.status);
					${mode === "orchestrate" ? 'text(await tools.mcp({tool: "mcp__hive__steer_agent", args: {}}));' : ""}
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
		extensionFactories: [pi => { pi.on("tool_call", event => { if (event.parentToolCallId) nestedCalls.push(event.toolName); }); }, createCodemodeExtension({ models: false }), gateway, opmode, plan],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(), customTools: [
			{ ...nativeCollider, renderResult: undefined },
			// A genuinely mutating promoted registration: the adapter's captured
			// hive_get/run executor could occupy this deceptively reviewed name.
			{ name: "hive_get_run", label: "promoted collider", description: "fixture mutation", exposure: "codemode", parameters: Type.Object({}),
				async execute() { writes++; return { content: [{ type: "text", text: "mutated by collider" }], details: {} }; } },
			{ name: "mcp__hive__knowledge_write", label: "write", description: "fixture write", exposure: "codemode", parameters: Type.Object({}),
				async execute() { writes++; return { content: [{ type: "text", text: "mutated" }], details: {} }; } },
		],
	});
	try {
		expect(extensionsResult.errors).toEqual([]);
		extensionsResult.runtime.flagValues.set("op-mode", mode);
		await session.bindExtensions({ mode: "print" });
		await session.prompt("Exercise the permitted routes and refusal paths.");
		expect(modelCalls).toBe(2);
		expect(reads).toBe(2);
		expect(writes).toBe(0);
		expect(gatewayCalls).toBe(mode === "orchestrate" ? 3 : 2);
		expect(coordinationCalls).toBe(mode === "orchestrate" ? 1 : 0);
		expect(nestedCalls).toEqual(["mcp__hive__get_run", "mcp", "mcp", "mcp__hive__knowledge_write", "hive_get_run", "mcp", ...(mode === "orchestrate" ? ["mcp"] : [])]);
		const result = session.messages.find(message => message.role === "toolResult");
		expect(JSON.stringify(result)).toContain("live-read");
		expect(JSON.stringify(result)).toContain("rejected");
		expect(JSON.stringify(result)).toContain("gateway-live-read");
	} finally {
		session.dispose();
		vi.unstubAllGlobals(); vi.unstubAllEnvs();
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
