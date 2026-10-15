import { mkdtemp, readFile, readdir, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createModels, normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClaudeSdkRuntime, type QueryFactory } from "../extensions/claude-sdk/provider.ts";
import { PiToolBridge } from "../extensions/claude-sdk/tool-bridge.ts";
import { assertSettledHistory, fingerprint, seedHistory } from "../extensions/claude-sdk/history.ts";
import { emptyUsage } from "../extensions/claude-sdk/events.ts";
import { hiveLease, launchConfig, LeaseManager, privateDirectory } from "../extensions/claude-sdk/runtime.ts";
import { workerExtensionPaths } from "../extensions/subagent/worker.ts";
import { chooseWorkerModel } from "../extensions/subagent/model.ts";
import { resolveYouShouldKnowModel } from "../extensions/you-should-know/index.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const lease = () => ({ access_token: "synthetic-access-only", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "account-a", slot: "slot-a" });
const tool = { name: "read", description: "Pi read", parameters: Type.Object({ path: Type.String() }) };
const context = () => normalizeContext({ systemPrompt: "UNCHANGED Pi system — no impersonation", tools: [tool], messages: [{ role: "user", content: "/literal @file", timestamp: 1 }] });
const message = (event: unknown): SDKMessage => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-000000000001", session_id: "fixture" }) as unknown as SDKMessage;
const start = () => message({ type: "message_start", message: { id: "response", usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 13, cache_creation_input_tokens: 17, cache_creation: { ephemeral_1h_input_tokens: 7 } } } });
const stop = (reason = "end_turn") => [message({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 19 } }), message({ type: "message_stop" })];
const result = { type: "result", subtype: "success", is_error: false } as SDKMessage;
function* text(value = "done") {
	yield start();
	yield message({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	yield message({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } });
	yield message({ type: "content_block_stop", index: 0 });
	yield* stop(); yield result;
}
function* tools(ids = ["call-a", "call-b"]) {
	yield start();
	for (const [index, id] of ids.entries()) {
		yield message({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__pi__read", input: {} } });
		yield message({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: id }) } });
		yield message({ type: "content_block_stop", index });
	}
	yield* stop("tool_use");
}
// Pinned SDK emits a canonical frame per completed block, sharing the response ID.
const canonical = (content: unknown[], stop_reason: string | null | undefined = null): SDKMessage => ({
	type: "assistant", parent_tool_use_id: null, message: { id: "response", content, stop_reason, usage: {} },
}) as SDKMessage;
function* interleavedTools(ids = ["call-a", "call-b"]) {
	for (const event of tools(ids)) {
		yield event;
		if (event.type === "stream_event" && event.event.type === "content_block_stop") {
			const id = ids[event.event.index];
			yield canonical([{ type: "tool_use", id, name: "mcp__pi__read", input: { path: id } }]);
		}
	}
}
async function fixture(query?: QueryFactory, leaseSource = vi.fn(async () => lease())) {
	const root = await mkdtemp(join(tmpdir(), "claude-sdk-offline-"));
	cleanups.push(() => rm(root, { force: true, recursive: true }));
	const config = { executable: "/pinned/claude", stateRoot: root, url: "https://hive.invalid", token: "synthetic-hive", launch: "launch-offline", cwd: process.cwd() };
	const requests: { options: Options; input: unknown }[] = [];
	const queryImpl: QueryFactory = query ?? (request => {
		const iterator = (async function* () {
			const input = await request.prompt[Symbol.asyncIterator]().next(); requests.push({ options: request.options, input: input.value });
			yield* text();
		})();
		return { [Symbol.asyncIterator]: () => iterator, close: vi.fn() };
	});
	const runtime = createClaudeSdkRuntime(config, { query: queryImpl, lease: leaseSource, validateExecutable: async () => {} });
	cleanups.push(runtime.close);
	const model = runtime.provider.getModels().find(m => m.id.includes("sonnet"))!;
	return { ...runtime, root, config, model, requests, leaseSource };
}
const sdkFailure = (code = "rate_limit", content: unknown[] = []): SDKMessage => ({
	type: "assistant", error: code, parent_tool_use_id: null, uuid: "SECRET-SDK-TOKEN", session_id: "SECRET-SDK-TOKEN",
	message: { id: "SECRET-SDK-TOKEN", content, stop_reason: null, model: "SECRET-SDK-TOKEN" },
}) as unknown as SDKMessage;
async function retrySession(f: Awaited<ReturnType<typeof fixture>>, maxRetries = 1, history: Message[] = []) {
	const modelRuntime = await ModelRuntime.create({ authPath: join(f.root, "pi-auth.json"), modelsPath: null,
		modelsStorePath: join(f.root, "models-store.json"), refreshOnCreate: false });
	modelRuntime.registerNativeProvider(f.provider);
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
	const settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries, baseDelayMs: 1, maxAgentDelayMs: 1 }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPromptOverride: () => "Pi retry boundary", extensionFactories: [pi => { pi.registerTool({ ...tool, label: "Read", execute }); }] });
	await loader.reload();
	const manager = SessionManager.inMemory(f.root);
	for (const entry of history) manager.appendMessage(entry);
	const { session } = await createAgentSession({ cwd: f.root, agentDir: f.root, modelRuntime, model: f.model,
		settingsManager: settings, resourceLoader: loader, tools: ["read"], sessionManager: manager });
	cleanups.push(async () => { session.dispose(); });
	await session.bindExtensions({ mode: "json" });
	const outputs: AssistantMessage[] = []; const retries: unknown[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") retries.push(event);
		if (event.type === "message_end" && event.message.role === "assistant") outputs.push(structuredClone(event.message));
	});
	return { session, execute, outputs, retries };
}
function correlated(output: AssistantMessage): Message[] {
	return output.content.flatMap(block => block.type === "toolCall" ? [{ role: "toolResult" as const, toolCallId: block.id, toolName: block.name,
		content: [{ type: "text" as const, text: `Pi result ${block.id}` }], isError: false, timestamp: 3 }] : []);
}

describe("offline production Claude SDK transport", () => {
	it("preserves prompt and literal input, emits balanced events, and accounts for cache tokens", async () => {
		const { provider, model, requests, root } = await fixture();
		const payload = vi.fn(); const observed = vi.fn(); const response = vi.fn();
		const stream = provider.streamSimple(model, context(), { onPayload: payload, onProviderStreamEvent: observed, onResponse: response });
		const types = []; for await (const event of stream) types.push(event.type);
		const output = await stream.result();
		expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(output).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 11, output: 19, cacheRead: 13, cacheWrite: 17, cacheWrite1h: 7, totalTokens: 60 } });
		expect(requests[0].options.systemPrompt).toBe("UNCHANGED Pi system — no impersonation");
		expect(requests[0].input).toMatchObject({ client_composed: true, message: { content: "/literal @file" } });
		expect(requests[0].options).toMatchObject({ persistSession: false, tools: [], settingSources: [], skills: [], plugins: [] });
		expect(Object.keys(requests[0].options.env!)).not.toContain("HIVE_TOKEN");
		expect(payload).toHaveBeenCalledOnce(); expect(observed).toHaveBeenCalled(); expect(response).not.toHaveBeenCalled();
		expect(await readdir(root)).toEqual([]);
	});
	it.each([false, true])("runs interleaved per-block canonical tools once through the real Pi agent and MCP (guard denial: %s)", async deny => {
		const results: unknown[] = []; const closed = vi.fn(); let starts = 0;
		const runtime = await fixture(request => {
			starts++;
			const client = new Client({ name: "fake-sdk", version: "1" });
			const iterator = (async function* () {
				await request.prompt[Symbol.asyncIterator]().next();
				const bridge = request.options.mcpServers!.pi;
				if (bridge.type !== "sdk") throw new Error("Expected SDK bridge");
				const [a, b] = InMemoryTransport.createLinkedPair();
				await bridge.instance.connect(b); await client.connect(a);
				try {
					yield* interleavedTools();
					// A per-block canonical frame may also arrive across the Pi tool boundary.
					yield canonical([{ type: "tool_use", id: "call-b", name: "mcp__pi__read", input: { path: "call-b" } }]);
					results.push(...await Promise.all(["call-a", "call-b"].map(id => client.callTool({ name: "read", arguments: { path: id }, _meta: { "claudecode/toolUseId": id } }))));
					yield* text("Pi kept control");
				} finally { await client.close(); await bridge.instance.close(); }
			})();
			return { [Symbol.asyncIterator]: () => iterator, close: () => { closed(); void client.close(); } };
		});
		const executed = vi.fn(async (_id: string, input: unknown) => ({ content: [{ type: "text" as const, text: (input as { path: string }).path }], details: undefined }));
		const before = vi.fn(async ({ toolCall }: { toolCall: { id: string } }) => deny && toolCall.id === "call-b" ? { block: true, reason: "Pi guard refused" } : undefined);
		const agent = new Agent({ initialState: { model: runtime.model, systemPrompt: "REAL PI PROMPT", tools: [{ ...tool, label: "Read", execute: executed }] },
			streamFn: (model, ctx, opts) => runtime.provider.streamSimple(model, normalizeContext(ctx), opts), beforeToolCall: before, sessionId: "pi-loop", toolExecution: "parallel" });
		await agent.prompt("test");
		expect(agent.state.errorMessage).toBeUndefined();
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ text: "Pi kept control" }] });
		expect(starts).toBe(1); expect(before).toHaveBeenCalledTimes(2); expect(executed).toHaveBeenCalledTimes(deny ? 1 : 2);
		expect(executed.mock.calls.map(([, input]) => input)).toEqual(deny ? [{ path: "call-a" }] : [{ path: "call-a" }, { path: "call-b" }]);
		expect(agent.state.messages.filter(m => m.role === "assistant").flatMap(m => m.content).filter(b => b.type === "toolCall").map(b => b.id)).toEqual(["call-a", "call-b"]);
		expect(results).toEqual([expect.objectContaining({ isError: false }), expect.objectContaining(deny ? { isError: true, content: [{ type: "text", text: "Pi guard refused" }] } : { isError: false })]);
		expect(closed).toHaveBeenCalledOnce();
	});
	it("retains the actual Pi session extension tool_call and tool_result pipeline", async () => {
		let delivered: unknown;
		const f = await fixture(request => {
			const client = new Client({ name: "fake-native-session-sdk", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				await request.prompt[Symbol.asyncIterator]().next();
				const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("No Pi bridge");
				const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
				try { yield* tools(["native-allowed", "native-denied"]);
					delivered = await Promise.all(["native-allowed", "native-denied"].map(id => client.callTool({ name: "read", arguments: { path: id }, _meta: { "claudecode/toolUseId": id } })));
					yield* text("native session completed");
				} finally { await client.close(); }
			})() };
		});
		const runtime = await ModelRuntime.create({ authPath: join(f.root, "pi-auth.json"), modelsPath: null,
			modelsStorePath: join(f.root, "models-store.json"), refreshOnCreate: false });
		const guard = vi.fn((event: { toolCallId: string }) => event.toolCallId === "native-denied" ? { block: true, reason: "session extension guard" } : undefined);
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Pi-owned execution" }], details: undefined }));
		const resultHook = vi.fn((event: { content: { type: "text" | "image" }[] }) => ({ content: [...event.content, { type: "text", text: "result hook retained" }] }));
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPromptOverride: () => "Pi-owned session prompt", extensionFactories: [pi => {
				pi.registerProvider(f.provider);
				pi.on("tool_call", guard);
				pi.registerTool({ ...tool, label: "Synthetic read", execute });
				pi.on("tool_result", event => { resultHook(event); return { content: [...event.content, { type: "text", text: "result hook retained" }] }; });
			}] });
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		runtime.registerNativeProvider(f.provider);
		const { session } = await createAgentSession({ cwd: f.root, agentDir: f.root, modelRuntime: runtime, model: f.model,
			settingsManager: settings, resourceLoader: loader, tools: ["read"], sessionManager: SessionManager.inMemory(f.root) });
		try {
			await session.bindExtensions({ mode: "json" });
			await session.prompt("Keep native guards");
			expect(session.getLastAssistantText()).toBe("native session completed"); expect(guard).toHaveBeenCalledTimes(2);
			expect(execute).toHaveBeenCalledOnce(); expect(resultHook).toHaveBeenCalledOnce();
			expect(delivered).toMatchObject([
				{ isError: false, content: [{ text: "Pi-owned execution" }, { text: "result hook retained" }] },
				{ isError: true, content: [{ text: "session extension guard" }] },
			]);
			expect(session.messages.some(m => m.role === "toolResult" && m.toolCallId === "native-denied")).toBe(true);
		} finally { session.dispose(); }
	});

	it("rebuilds canonical next-turn history, not replaying previous user turns or tools", async () => {
		const { provider, model, requests, root } = await fixture();
		const ctx = context();
		const first = await provider.streamSimple(model, ctx).result();
		ctx.messages.push(first, { role: "user", content: "next", timestamp: 2 });
		let seed = ""; let mode = 0;
		const secondRuntime = await fixture(request => {
			const iterator = (async function* () {
				seed = await readFile(request.options.resume!, "utf8"); mode = (await stat(request.options.resume!)).mode & 0o777;
				const next = await request.prompt[Symbol.asyncIterator]().next(); expect(next.value.message.content).toBe("next");
				yield* text();
			})(); return { [Symbol.asyncIterator]: () => iterator, close() {} };
		});
		expect((await secondRuntime.provider.streamSimple(model, ctx).result()).stopReason).toBe("stop");
		expect(seed).toContain("/literal @file"); expect(seed).toContain('"role":"assistant"'); expect(seed).not.toContain("synthetic-access-only");
		expect(mode).toBe(0o600); expect(requests).toHaveLength(1); expect(await readdir(root)).toEqual([]);
	});
	it.each([false, true])("normalizes foreign completed OpenAI history and rebuilt following results (following: %s)", async following => {
		const ids = ["call_abc|fc_xyz", "a".repeat(449) + "x", "a".repeat(449) + "y", "a|b", "a/b", "a_b", "toolu_native-OK"];
		let seed: { message: { content: { type: string; id?: string; tool_use_id?: string }[] } }[] = [];
		let input: unknown; let queries = 0;
		const f = await fixture(request => ({ close() {}, [Symbol.asyncIterator]: () => (async function* () {
			queries++;
			seed = (await readFile(request.options.resume!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
			input = (await request.prompt[Symbol.asyncIterator]().next()).value;
			yield* text("foreign history accepted offline");
		})() }));
		const assistant: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-foreign",
			content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
			usage: emptyUsage(), stopReason: "toolUse", timestamp: 2 };
		const results = correlated(assistant);
		const ctx = context(); ctx.messages.push(assistant, ...results);
		if (!following) ctx.messages.push({ role: "user", content: "handoff to SDK", timestamp: 4 });
		const canonical = structuredClone(ctx);
		expect((await f.provider.streamSimple(f.model, ctx).result()).stopReason).toBe("stop");
		const wireIds = seed.flatMap(entry => Array.isArray(entry.message.content) ? entry.message.content : []).filter(block => block.type === "tool_use").map(block => block.id);
		expect(wireIds).toHaveLength(ids.length); expect(new Set(wireIds).size).toBe(ids.length);
		for (const id of wireIds) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(wireIds.slice(-2)).toEqual(ids.slice(-2));
		const wireResults = following ? (input as { message: { content: { tool_use_id: string }[] } }).message.content.map(block => block.tool_use_id)
			: seed.flatMap(entry => Array.isArray(entry.message.content) ? entry.message.content : []).filter(block => block.type === "tool_result").map(block => block.tool_use_id);
		expect(wireResults).toEqual(wireIds);
		expect(ctx).toEqual(canonical); expect(queries).toBe(1);
	});
	it.each(["error", "aborted"] as const)("omits %s frames only from SDK history without synthesizing results or hiding pending effects", async stopReason => {
		const failed: AssistantMessage = { role: "assistant", api: "claude-sdk", provider: "claude-sdk", model: "fixture", timestamp: 1,
			content: [{ type: "toolCall", id: "failed-proposal", name: "read", arguments: {} }], usage: emptyUsage(), stopReason };
		const history: Message[] = [{ role: "user", content: "old prompt", timestamp: 0 }, failed];
		const before = structuredClone(history);
		const root = await mkdtemp(join(tmpdir(), "sdk-failed-history-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
		const path = await seedHistory(root, history, "fixture", process.cwd(), { id: "fixture", api: "claude-sdk", provider: "claude-sdk" });
		const entries = (await readFile(path!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		expect(entries).toHaveLength(1); expect(entries[0].message).toMatchObject({ role: "user", content: "old prompt" });
		expect(history).toEqual(before);
		expect(() => assertSettledHistory([...history, { ...failed, stopReason: "toolUse" }])).toThrow(/Unresolved historical/);
		expect(() => assertSettledHistory([{ ...failed, stopReason: "toolUse" }, ...history])).toThrow(/Unresolved historical/);
		expect(() => assertSettledHistory([...history, ...correlated(failed)])).toThrow(/Uncorrelated historical/);
	});
	it("rejects a normalized-ID collision with a valid native ID rather than miscorrelating results", () => {
		const foreign = "foreign|id";
		const assistant: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "openai", model: "foreign", timestamp: 1,
			content: [foreign, fingerprint(foreign)].map(id => ({ type: "toolCall", id, name: "read", arguments: {} })), usage: emptyUsage(), stopReason: "toolUse" };
		expect(() => assertSettledHistory([assistant, ...correlated(assistant)])).toThrow(/Colliding historical SDK tool IDs/);
	});
	it("cancels a blocked SDK iterator, cleans pending tools and refuses ambiguous retries", async () => {
		const close = vi.fn(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
		const { provider, model, root } = await fixture(request => ({
			[Symbol.asyncIterator]: () => (async function* () { started(); await new Promise(resolve => request.options.abortController!.signal.addEventListener("abort", resolve, { once: true })); yield result; })(), close,
		}));
		const abort = new AbortController(); const ctx = context();
		const output = provider.streamSimple(model, ctx, { signal: abort.signal, sessionId: "cancel" }).result();
		await ready; abort.abort();
		expect((await output).stopReason).toBe("aborted"); expect(close).toHaveBeenCalledOnce(); expect(await readdir(root)).toEqual([]);
		expect((await provider.streamSimple(model, ctx, { sessionId: "cancel" }).result()).errorMessage).toMatch(/Ambiguous/);
	});
	it.each([1, 2])("quarantines cancelled parked delivery after toolUse with %i calls through the real Agent", async count => {
		const ids = ["delivered", "cancelled"].slice(2 - count);
		const cancel = new AbortController(); let client!: Client; let queries = 0;
		const replies: Promise<unknown>[] = [];
		const f = await fixture(request => {
			const attempt = ++queries;
			client = new Client({ name: "cancel-after-toolUse", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				if (attempt > 1) { yield* text("independent completed"); return; }
				const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("No bridge");
				const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
				yield* tools(ids);
				throw new Error("Cancelled continuation must not resume SDK iterator");
			})() };
		});
		let attempted: ReturnType<typeof normalizeContext> | undefined;
		const outputs: AssistantMessage[] = [];
		const execute = vi.fn(async () => {
			// Pi only executes after the completed toolUse output. Cancel MCP now,
			// not while the provider is still validating the streamed tool batch.
			if (!replies.length) {
				for (const id of ids) replies.push(client.callTool({ name: "read", arguments: { path: id },
					_meta: { "claudecode/toolUseId": id } }, undefined, id === "cancelled" ? { signal: cancel.signal } : undefined).catch(error => error));
				await client.ping(); cancel.abort(); await replies.at(-1); await client.ping();
			}
			return { content: [{ type: "text" as const, text: "Pi already executed" }], details: undefined };
		});
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] }, sessionId: "parked-cancel",
			streamFn: (model, ctx, opts) => {
				const canonical = normalizeContext(ctx);
				if (canonical.messages.at(-1)?.role === "toolResult") attempted = structuredClone(canonical);
				return f.provider.streamSimple(model, canonical, opts);
			} });
		agent.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") outputs.push(structuredClone(event.message)); });
		const completion = vi.spyOn(PiToolBridge.prototype, "complete");
		let deliveries: { id: string; type: string; value: unknown }[];
		try {
			await agent.prompt("execute before MCP cancellation");
			deliveries = completion.mock.calls.map(([result], index) => ({ id: result.toolCallId, ...completion.mock.results[index] }));
		} finally { completion.mockRestore(); }
		expect(deliveries!.map(({ id, type }) => ({ id, type }))).toEqual(ids.map(id => ({ id, type: id === "cancelled" ? "throw" : "return" })));
		expect(deliveries!.at(-1)!.value).toMatchObject({ message: "MCP tool request cancelled; reconcile before retrying" });
		expect(execute).toHaveBeenCalledTimes(count);
		expect(outputs[0].stopReason).toBe("toolUse");
		expect(outputs.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "Claude SDK interrupted or failed; reconcile any pending side effects before retrying" });
		expect(attempted).toBeDefined();
		expect(attempted!.messages.filter(m => m.role === "toolResult")).toHaveLength(count);
		// The first bridge completion succeeds before its sibling throws, but
		// fail-closed disposal can close MCP before that queued reply is sent.
		await Promise.all(replies);
		expect(await readdir(f.root)).toEqual([]);
		const retry = await f.provider.streamSimple(f.model, attempted!, { sessionId: "parked-cancel" }).result();
		expect(retry.errorMessage).toMatch(/Ambiguous previous/); expect(queries).toBe(1);
		const independent = normalizeContext({ tools: [tool], messages: [{ role: "user", content: "independent", timestamp: 4 }] });
		expect((await f.provider.streamSimple(f.model, independent, { sessionId: "parked-cancel" }).result()).stopReason).toBe("stop");
		expect(queries).toBe(2); expect(await readdir(f.root)).toEqual([]);
		await f.close(); expect(await readdir(f.root)).toEqual([]);
	});
	it("cleans private setup state when an invalid tool name rejects bridge construction", async () => {
		const f = await fixture();
		const ctx = normalizeContext({ tools: [{ ...tool, name: "bad.name" }], messages: [{ role: "user", content: "invalid tool", timestamp: 1 }] });
		expect((await f.provider.streamSimple(f.model, ctx).result()).errorMessage).toMatch(/Invalid Pi tool names/);
		expect(f.requests).toEqual([]); expect(await readdir(f.root)).toEqual([]);
		await f.close(); expect(await readdir(f.root)).toEqual([]);
	});
	it("canonicalizes duplicate tool declarations at the provider boundary and leaves no private state", async () => {
		const f = await fixture();
		// Pi resolves tools by name before constructing the bridge; duplicate
		// transcript declarations cannot reach its constructor as duplicates.
		const ctx = normalizeContext({ tools: [tool, tool], messages: [{ role: "user", content: "duplicate tools", timestamp: 1 }] });
		expect((await f.provider.streamSimple(f.model, ctx).result()).stopReason).toBe("stop");
		expect(f.requests).toHaveLength(1); expect(f.requests[0].options.allowedTools).toEqual(["mcp__pi__read"]);
		expect(await readdir(f.root)).toEqual([]);
		await f.close(); expect(await readdir(f.root)).toEqual([]);
	});
	it.each(["fetch", "headers", "env", "mutation"])("rejects unsupported HTTP/config mutation: %s", async kind => {
		const { provider, model, requests } = await fixture();
		const opts = kind === "fetch" ? { fetch } : kind === "headers" ? { headers: { authorization: "not-allowed" } } :
			kind === "env" ? { env: { ANTHROPIC_API_KEY: "not-allowed" } } : { onPayload: () => ({ injected: true }) };
		expect((await provider.streamSimple(model, context(), opts).result()).stopReason).toBe("error"); expect(requests).toHaveLength(0);
	});
	it("rejects unresolved historical tools rather than re-executing a possibly completed side effect", async () => {
		const { provider, model, requests } = await fixture();
		const ctx = context();
		ctx.messages.push({ role: "assistant", provider: "claude-sdk", api: "claude-sdk", model: model.id, content: [{ type: "toolCall", id: "ambiguous", name: "read", arguments: {} }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 }, { role: "user", content: "retry", timestamp: 3 });
		expect((await provider.streamSimple(model, ctx).result()).errorMessage).toMatch(/Unresolved historical/); expect(requests).toHaveLength(0);
	});
	it("advertises the native provider to helper discovery and explicit worker allowlists", async () => {
		const { provider, model } = await fixture();
		const models = createModels(); models.setProvider(provider);
		expect(models.getModel("claude-sdk", model.id)).toBeDefined();
		expect((await models.getAvailable("claude-sdk")).length).toBeGreaterThan(0);
		expect(workerExtensionPaths()).toContain(resolve("extensions/claude-sdk/index.ts"));
		const spec = `claude-sdk/${model.id}`;
		expect(await chooseWorkerModel({ requested: spec, roleName: "reviewer" }, { isConfigured: s => s === spec, catalog: async () => [] })).toEqual({ spec });
		vi.stubEnv("PI_YOU_SHOULD_KNOW_MODEL", spec);
		expect(await resolveYouShouldKnowModel({ modelRegistry: { find: (p: string, id: string) => models.getModel(p, id), getApiKeyAndHeaders: async () => ({ ok: true }) } } as never)).toBe(model);
	});
});

describe("conservative post-start SDK failures through Pi AgentSession", () => {
	it.each(["overloaded", "rate_limit", "server_error"])("never retries an empty classified %s failure without a nonexecution guarantee", async code => {
		const options: Options[] = []; const closed = vi.fn();
		const f = await fixture(request => {
			options.push(request.options);
			return { close: closed, [Symbol.asyncIterator]: () => (async function* () {
				await request.prompt[Symbol.asyncIterator]().next();
				yield sdkFailure(code);
			})() };
		});
		const { session, outputs, retries, execute } = await retrySession(f, 2);
		await session.prompt("fresh request");
		expect(retries).toEqual([]); expect(options).toHaveLength(1); expect(closed).toHaveBeenCalledOnce();
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toMatchObject({ stopReason: "error", content: [], errorMessage: "Claude SDK interrupted or failed; reconcile any pending side effects before retrying",
			diagnostics: [{ type: "claude_sdk_assistant_failure", timestamp: expect.any(Number),
				error: { message: "Claude SDK assistant failure", code }, details: { retrySafe: false } }] });
		expect(JSON.stringify(outputs)).not.toContain("SECRET-SDK-TOKEN");
		expect(execute).not.toHaveBeenCalled();
		expect((await readdir(f.root)).filter(name => name.startsWith("query-"))).toEqual([]);
	});
	it("does not retry a parked continuation after Pi execution", async () => {
		let queries = 0;
		const f = await fixture(() => { queries++; return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
			yield* tools(["already-executed"]); yield sdkFailure("server_error");
		})() }; });
		const { session, retries, outputs, execute } = await retrySession(f, 2);
		await session.prompt("tool continuation");
		expect(execute).toHaveBeenCalledOnce(); expect(queries).toBe(1); expect(retries).toEqual([]);
		expect(outputs.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "Claude SDK interrupted or failed; reconcile any pending side effects before retrying",
			diagnostics: [{ error: { code: "server_error" }, details: { retrySafe: false } }] });
		expect((await readdir(f.root)).filter(name => name.startsWith("query-"))).toEqual([]);
	});
	it.each(["overloaded", "rate_limit", "server_error", "unknown", "synchronous-throw", "started", "tool-proposal", "history"])("quarantines the exact failed %s context against explicit replay", async mode => {
		let queries = 0;
		const f = await fixture(() => { queries++;
			if (mode === "synchronous-throw") throw new Error("rate_limit SECRET-SDK-TOKEN");
			return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
			if (mode === "unknown") throw new Error("rate_limit SECRET-SDK-TOKEN");
			if (mode === "started") yield start();
			if (mode === "tool-proposal") { for (const frame of tools(["unexecuted"])) { if (frame.type === "stream_event" && frame.event.type === "message_stop") break; yield frame; } }
			yield sdkFailure(["overloaded", "rate_limit", "server_error"].includes(mode) ? mode : "overloaded");
		})() }; });
		const ctx = context(); if (mode === "history") ctx.messages.unshift({ role: "user", content: "old history", timestamp: 0 });
		const first = await f.provider.streamSimple(f.model, ctx, { sessionId: "quarantine" }).result();
		expect(first.errorMessage).toBe("Claude SDK interrupted or failed; reconcile any pending side effects before retrying");
		expect((await f.provider.streamSimple(f.model, ctx, { sessionId: "quarantine" }).result()).errorMessage).toMatch(/Ambiguous previous/);
		expect(queries).toBe(1); expect(await readdir(f.root)).toEqual([]);
	});
	it("quarantines a classified failure without preventing an independent request", async () => {
		let queries = 0;
		const f = await fixture(() => { const attempt = ++queries; return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
			if (attempt === 1) yield sdkFailure("overloaded"); else yield* text("independent request completed");
		})() }; });
		const ctx = context();
		expect((await f.provider.streamSimple(f.model, ctx, { sessionId: "reuse" }).result()).stopReason).toBe("error");
		expect((await f.provider.streamSimple(f.model, ctx, { sessionId: "reuse" }).result()).errorMessage).toMatch(/Ambiguous previous/);
		ctx.messages = [{ role: "user", content: "independent request", timestamp: 2 }];
		expect((await f.provider.streamSimple(f.model, ctx, { sessionId: "reuse" }).result()).stopReason).toBe("stop");
		expect(queries).toBe(2); expect(await readdir(f.root)).toEqual([]);
	});
	it.each(["unknown-exception", "unknown-code", "started", "text", "tool-proposal", "failure-content", "mcp-missing-id", "mcp-pending", "mcp-discovery", "mcp-connect", "history"])("never retries ambiguous %s even with Pi retries enabled", async mode => {
		let queries = 0; let pending: Promise<unknown> | undefined;
		const f = await fixture(request => {
			queries++; const client = new Client({ name: "unsafe-retry-probe", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				await request.prompt[Symbol.asyncIterator]().next();
				if (mode.startsWith("mcp-")) {
					const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("No bridge");
					const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
					if (mode === "mcp-discovery") await client.listTools();
					else if (mode === "mcp-missing-id") expect(await client.callTool({ name: "read", arguments: {} })).toMatchObject({ isError: true });
					else if (mode === "mcp-pending") { pending = client.callTool({ name: "read", arguments: { path: "unknown" }, _meta: { "claudecode/toolUseId": "unknown" } }).catch(error => error); await client.ping(); }
					else await client.ping(); // Drain initialized notification before the failure.
				}
				if (mode === "unknown-exception") throw new Error("SECRET-SDK-TOKEN rate_limit server_error overloaded");
				if (mode === "started") yield start();
				if (mode === "text") { for (const frame of text("partial output")) { if (frame.type === "result") break; yield frame; } }
				if (mode === "tool-proposal") { for (const frame of tools(["unexecuted"])) { if (frame.type === "stream_event" && frame.event.type === "message_stop") break; yield frame; } }
				yield sdkFailure(mode === "unknown-code" ? "SECRET-SDK-TOKEN" : "rate_limit", mode === "failure-content" ? [{ type: "text", text: "SECRET-SDK-TOKEN" }] : []);
			})() };
		});
		const history: Message[] = mode === "history" ? [{ role: "user", content: "old turn", timestamp: 1 }] : [];
		const { session, retries, outputs, execute } = await retrySession(f, 2, history);
		await session.prompt("ambiguous request");
		expect(queries).toBe(1); expect(retries).toEqual([]); expect(execute).not.toHaveBeenCalled();
		expect(outputs.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "Claude SDK interrupted or failed; reconcile any pending side effects before retrying" });
		if (!["unknown-exception", "unknown-code"].includes(mode)) expect(outputs.at(-1)?.diagnostics).toMatchObject([{ error: { code: "rate_limit" }, details: { retrySafe: false } }]);
		expect(JSON.stringify(outputs)).not.toContain("SECRET-SDK-TOKEN");
		if (pending) await pending;
		expect((await readdir(f.root)).filter(name => name.startsWith("query-"))).toEqual([]);
	});
});

describe("stream and lifecycle edge cases", () => {
	it.each(["thinking", "redacted_thinking"])("preserves %s blocks and signatures", async type => {
		const { provider, model } = await fixture(() => ({ close() {}, [Symbol.asyncIterator]: () => (async function* () {
			yield start();
			yield message({ type: "content_block_start", index: 0, content_block: { type, data: "opaque", thinking: "", signature: "" } });
			if (type === "thinking") {
				yield message({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } });
				yield message({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } });
			}
			yield message({ type: "content_block_stop", index: 0 }); yield* stop(); yield result;
		})() }));
		const output = await provider.streamSimple(model, context()).result();
		expect(output.stopReason).toBe("stop");
		expect(output.content[0]).toMatchObject(type === "thinking" ? { thinking: "reasoning", thinkingSignature: "signed" } : { redacted: true, thinkingSignature: "opaque" });
	});
	it("maps max_tokens and empty text to balanced length completion", async () => {
		const { provider, model } = await fixture(() => ({ close() {}, [Symbol.asyncIterator]: () => (async function* () {
			yield start(); yield* stop("max_tokens"); yield result;
		})() }));
		const output = await provider.streamSimple(model, context()).result();
		expect(output.stopReason).toBe("length"); expect(output.content).toEqual([]);
	});
	it.each(["builtin", "malformed", "compaction"])("fails closed on %s SDK output", async kind => {
		const { provider, model } = await fixture(() => ({ close() {}, [Symbol.asyncIterator]: () => (async function* () {
			yield start();
			if (kind === "builtin") yield message({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "foreign", name: "Bash", input: {} } });
			if (kind === "malformed") yield message({ type: "content_block_stop", index: 0 });
			if (kind === "compaction") yield { type: "system", subtype: "compact_boundary" } as SDKMessage;
		})() }));
		expect((await provider.streamSimple(model, context()).result()).stopReason).toBe("error");
	});
	it("isolates concurrent anonymous helpers even with identical prompts", async () => {
		const { provider, model, requests } = await fixture();
		const outputs = await Promise.all([provider.streamSimple(model, context()).result(), provider.streamSimple(model, context()).result()]);
		expect(outputs.map(output => output.stopReason)).toEqual(["stop", "stop"]);
		expect(requests[0].options.env!.HOME).not.toBe(requests[1].options.env!.HOME);
	});
	it("rebuilds a completed tool batch under a rotated account without reissuing the calls", async () => {
		let account = "account-a"; const seen: unknown[] = []; const closes = vi.fn(); let queries = 0;
		const { provider, model } = await fixture(request => {
			const index = queries++;
			return { close: closes, [Symbol.asyncIterator]: () => (async function* () {
				seen.push((await request.prompt[Symbol.asyncIterator]().next()).value);
				if (!index) yield* tools(["account-call"]); else {
					const seed = await readFile(request.options.resume!, "utf8");
					expect(seed).toContain('"tool_use"'); expect(seed).not.toContain("synthetic-access-only"); yield* text();
				}
			})() };
		}, vi.fn(async () => ({ ...lease(), credential: account })));
		const ctx = context(); const first = await provider.streamSimple(model, ctx, { sessionId: "account" }).result();
		account = "account-b"; ctx.messages.push(first, ...correlated(first));
		expect((await provider.streamSimple(model, ctx, { sessionId: "account" }).result()).stopReason).toBe("stop");
		expect(queries).toBe(2); expect(closes).toHaveBeenCalledTimes(2);
		expect(seen[1]).toMatchObject({ message: { content: [{ type: "tool_result", tool_use_id: "account-call" }] } });
	});
	it.each(["abort", "expiry"])("parked %s quarantines the original attempt but allows correlated reconstruction", async boundary => {
		vi.useFakeTimers();
		try {
			const close = vi.fn(); let queries = 0;
			const f = await fixture(() => {
				const first = ++queries === 1;
				return { close, [Symbol.asyncIterator]: () => (async function* () {
					if (first) yield* tools(["parked-call"]); else yield* text("correlated reconstruction");
				})() };
			});
			const controller = new AbortController(); const ctx = context();
			const first = await f.provider.streamSimple(f.model, ctx, { signal: controller.signal }).result();
			expect(first.stopReason).toBe("toolUse");
			// Pi can already have executed this handoff before cancellation or expiry.
			if (boundary === "abort") controller.abort();
			else await vi.advanceTimersByTimeAsync(5 * 60_000);
			await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]));
			expect(close).toHaveBeenCalledOnce();
			const replay = await f.provider.streamSimple(f.model, ctx).result();
			expect(replay).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/Ambiguous previous SDK attempt/) });
			expect(queries).toBe(1);
			ctx.messages.push(first, ...correlated(first));
			expect((await f.provider.streamSimple(f.model, ctx).result()).stopReason).toBe("stop");
			expect(queries).toBe(2); expect(close).toHaveBeenCalledTimes(2);
		} finally { vi.useRealTimers(); }
	});
	it.each(["edit", "compaction", "fork", "model-switch", "steering"])("canonical %s boundary rebuilds without reexecuting old tools", async boundary => {
		let queries = 0;
		const f = await fixture(request => {
			const query = queries++;
			return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
				const input = (await request.prompt[Symbol.asyncIterator]().next()).value;
				if (!query) yield* tools(["boundary-call"]);
				else { expect(input.client_composed).toBe(true); yield* text("rebuilt"); }
			})() };
		});
		const ctx = context();
		const first = await f.provider.streamSimple(f.model, ctx, { sessionId: "original" }).result();
		ctx.messages.push(first, ...correlated(first));
		if (boundary === "edit" && ctx.messages[0].role === "system") ctx.messages[0].content = "Edited canonical Pi prompt";
		if (boundary === "compaction") ctx.messages = normalizeContext({ systemPrompt: "Pi prompt", messages: [{ role: "user", content: "Canonical compacted summary", timestamp: 4 }] }).messages;
		if (boundary === "steering") ctx.messages.push({ role: "user", content: "New steering instruction", timestamp: 5 });
		const model = boundary === "model-switch" ? f.provider.getModels().find(m => m.id !== f.model.id)! : f.model;
		const output = await f.provider.streamSimple(model, ctx, { sessionId: boundary === "fork" ? "fork" : "original" }).result();
		expect(output.stopReason).toBe("stop"); expect(queries).toBe(2); expect(output.content).toEqual([{ type: "text", text: "rebuilt" }]);
	});

	it("shutdown is idempotent and closes all parked helper queries", async () => {
		const closes = vi.fn(); let id = 0;
		const { provider, model, root, close } = await fixture(() => ({ close: closes, [Symbol.asyncIterator]: () => (async function* () { yield* tools([`shutdown-${id++}`]); })() }));
		await Promise.all([provider.streamSimple(model, context()).result(), provider.streamSimple(model, context()).result()]);
		await close(); await close(); expect(closes).toHaveBeenCalledTimes(2); expect(await readdir(root)).toEqual([]);
	});
});

describe("access-only leases and launch isolation", () => {
	it("is disabled by default and rejects incomplete or unsafe launch config", () => {
		expect(launchConfig({}, process.cwd())).toBeUndefined();
		expect(() => launchConfig({ HIVE_CLAUDE_SDK: "1" }, process.cwd())).toThrow(/requires/);
	});
	it("requests only the launch access-only endpoint with no auth-store fallback", async () => {
		const f = await fixture(); const fetcher = vi.fn(async () => new Response(JSON.stringify(lease())));
		expect(await hiveLease(f.config, fetcher as typeof fetch)(new AbortController().signal)).toMatchObject({ credential: "account-a" });
		expect(fetcher.mock.calls[0]).toEqual(["https://hive.invalid/api/v1/agent-launches/launch-offline/claude-auth", expect.objectContaining({ method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-hive" } })]);
	});
	it("does not leak malformed lease bodies through JSON parser diagnostics", async () => {
		const f = await fixture();
		const source = hiveLease(f.config, (async () => new Response("secret-not-valid-json")) as typeof fetch);
		await expect(source(new AbortController().signal)).rejects.toThrow("Invalid access-only Claude lease response");
	});
	it("coalesces concurrent leases but reauthorizes later requests; no same-token near-expiry loop", async () => {
		const source = vi.fn(async () => lease()); const manager = new LeaseManager(source);
		const signal = new AbortController().signal;
		await Promise.all([manager.get(signal), manager.get(signal)]); expect(source).toHaveBeenCalledTimes(1);
		await manager.get(signal); expect(source).toHaveBeenCalledTimes(2);
		const near = vi.fn(async () => ({ ...lease(), expires_at: new Date(Date.now() + 30_000).toISOString() }));
		await expect(new LeaseManager(near).get(signal)).rejects.toThrow(/near expiry/); expect(near).toHaveBeenCalledOnce();
	});
	it("does not chmod a shared state root; concurrent helpers receive separate 0700 roots", async () => {
		const { root } = await fixture();
		const [a, b] = await Promise.all([privateDirectory(root), privateDirectory(root)]);
		expect(a).not.toBe(b); expect((await stat(a)).mode & 0o777).toBe(0o700);
		await chmod(root, 0o755); await expect(privateDirectory(root)).rejects.toThrow(/0700/);
	});
});


describe("review regressions: reservation and observer ownership", () => {
	it("does not execute a late model tool after MCP registration timed out", async () => {
		let dispatched!: () => void;
		const ready = new Promise<void>(resolve => { dispatched = resolve; });
		const f = await fixture(request => {
			const client = new Client({ name: "late-sdk", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("No Pi bridge");
				const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
				const early = client.callTool({ name: "read", arguments: { path: "late-call" }, _meta: { "claudecode/toolUseId": "late-call" } });
				dispatched();
				expect(await early).toMatchObject({ isError: true });
				yield* tools(["late-call"]);
			})() };
		});
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] },
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), opts) });
		vi.useFakeTimers();
		const pending = agent.prompt("offline late tool");
		try {
			await ready; await vi.advanceTimersByTimeAsync(10_001); await pending;
			expect(execute).not.toHaveBeenCalled();
			expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		} finally { vi.useRealTimers(); await f.close(); await pending; }
	});
	it("keeps A's session reservation after B rejects, so C also rejects during A's lease wait", async () => {
		let entered!: () => void; let release!: (value: ReturnType<typeof lease>) => void;
		const ready = new Promise<void>(resolve => { entered = resolve; });
		const held = new Promise<ReturnType<typeof lease>>(resolve => { release = resolve; });
		const f = await fixture(undefined, vi.fn(async () => { entered(); return held; }));
		const a = f.provider.streamSimple(f.model, context(), { sessionId: "reserved" }).result();
		await ready;
		try {
			expect((await f.provider.streamSimple(f.model, context(), { sessionId: "reserved" }).result()).errorMessage).toMatch(/Concurrent/);
			let third: AssistantMessage | undefined;
			const c = f.provider.streamSimple(f.model, context(), { sessionId: "reserved" }).result().then(value => { third = value; });
			try {
				await vi.waitFor(() => expect(third?.errorMessage).toMatch(/Concurrent/));
				expect(f.leaseSource).toHaveBeenCalledOnce();
			} finally { release(lease()); await c; }
		} finally { release(lease()); await a; }
		expect(f.requests).toHaveLength(1);
	});

	it.each(["onPayload", "onProviderStreamEvent"] as const)("cancels blocked %s on abort and observes its later rejection", async hook => {
		let entered!: () => void; let reject!: (error: Error) => void;
		const ready = new Promise<void>(resolve => { entered = resolve; });
		const blocked = new Promise<void>((_, fail) => { reject = fail; });
		const f = await fixture(); const abort = new AbortController();
		let output: AssistantMessage | undefined;
		const pending = f.provider.streamSimple(f.model, context(), { signal: abort.signal,
			[hook]: () => { entered(); return blocked; } }).result().then(value => { output = value; });
		await ready; abort.abort();
		try { await vi.waitFor(() => expect(output?.stopReason).toBe("aborted")); }
		finally { reject(new Error("late observer rejection")); await pending; }
		expect(await readdir(f.root)).toEqual([]);
	});

	it.each(["onPayload", "onProviderStreamEvent"] as const)("runtime.close drains blocked %s without waiting for the observer", async hook => {
		let entered!: () => void; let reject!: (error: Error) => void;
		const ready = new Promise<void>(resolve => { entered = resolve; });
		const blocked = new Promise<void>((_, fail) => { reject = fail; });
		const f = await fixture(); let output: AssistantMessage | undefined; let closed = false;
		const pending = f.provider.streamSimple(f.model, context(), {
			[hook]: () => { entered(); return blocked; } }).result().then(value => { output = value; });
		await ready; const closing = f.close().then(() => { closed = true; });
		try { await vi.waitFor(() => { expect(output?.stopReason).toBe("aborted"); expect(closed).toBe(true); }); }
		finally { reject(new Error("late shutdown observer rejection")); await pending; await closing; }
		expect(await readdir(f.root)).toEqual([]);
	});

	it("lease expiry cancels a blocked provider-event observer", async () => {
		let entered!: () => void; let release!: () => void;
		const ready = new Promise<void>(resolve => { entered = resolve; });
		const blocked = new Promise<void>(resolve => { release = resolve; });
		const f = await fixture(); vi.useFakeTimers();
		const pending = f.provider.streamSimple(f.model, context(), { onProviderStreamEvent: () => { entered(); return blocked; } }).result();
		try {
			await ready; await vi.advanceTimersByTimeAsync(3600_000);
			expect((await pending).stopReason).toBe("error"); expect(await readdir(f.root)).toEqual([]);
		} finally { release(); await pending; vi.useRealTimers(); }
	});
});


describe("catalog-driven SDK reasoning options", () => {
	const capabilities = [
		["claude-haiku-4-5", false, false, false, true, true],
		["claude-haiku-4-5-20251001", false, false, false, true, true],
		["claude-opus-4-5", false, false, false, true, true],
		["claude-opus-4-5-20251101", false, false, false, true, true],
		["claude-sonnet-4-5", false, false, false, true, true],
		["claude-sonnet-4-5-20250929", false, false, false, true, true],
		["claude-opus-4-6", true, false, true, true, true],
		["claude-sonnet-4-6", true, false, true, true, true],
		["claude-opus-4-7", true, true, true, true, true],
		["claude-opus-4-8", true, true, true, true, true],
		["claude-sonnet-5", true, true, true, true, true],
		["claude-fable-5", true, true, true, false, true],
		["claude-fable-5-1", true, true, true, false, true],
		["claude-opus-5", true, true, true, false, true],
		["claude-opus-5-5", true, true, true, false, false],
		["claude-sonnet-5-5", true, true, true, false, false],
	] as const;
	it.each(capabilities)("translates every advertised level for %s", async (id, adaptive, xhigh, max, off, minimal) => {
		const f = await fixture(); const model = f.provider.getModels().find(m => m.id === id)!;
		expect(model).toBeDefined();
		for (const reasoning of [undefined, "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			const before = f.requests.length;
			const output = await f.provider.streamSimple(model, context(), { reasoning }).result();
			if (reasoning === "xhigh" && !xhigh || reasoning === "max" && !max || reasoning === "minimal" && !minimal) {
				expect(output.errorMessage).toMatch(/Unsupported.*thinking level/); expect(f.requests).toHaveLength(before); continue;
			}
			expect(output.stopReason).toBe("stop");
			const options = f.requests.at(-1)!.options;
			if (!reasoning && off) {
				expect(options.thinking).toEqual({ type: "disabled" }); expect(options.effort).toBeUndefined();
			} else if (adaptive) {
				expect(options.thinking).toEqual({ type: "adaptive" });
				expect(options.effort).toBe(reasoning === "minimal" ? "low" : reasoning ?? "high");
			} else {
				const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
				expect(options.thinking).toEqual({ type: "enabled", budgetTokens: budgets[reasoning as keyof typeof budgets] });
				expect(options.effort).toBeUndefined();
			}
		}
	});
	it("covers the complete advertised model catalog", async () => {
		const f = await fixture();
		expect(f.provider.getModels().map(m => m.id).sort()).toEqual(capabilities.map(([id]) => id).sort());
	});
	it("accepts explicit budgets only for budget models and rejects unsupported or invalid knobs before dispatch", async () => {
		const f = await fixture();
		const budget = f.provider.getModels().find(m => m.id === "claude-haiku-4-5")!;
		const adaptive = f.provider.getModels().find(m => m.id === "claude-opus-4-7")!;
		expect((await f.provider.streamSimple(budget, context(), { reasoning: "high", thinkingBudgets: { high: 4096 } }).result()).stopReason).toBe("stop");
		expect(f.requests.at(-1)!.options.thinking).toEqual({ type: "enabled", budgetTokens: 4096 });
		const rejected = [
			{ model: adaptive, options: { reasoning: "high" as const, thinkingBudgets: { high: 4096 } } },
			{ model: budget, options: { thinkingBudgets: { high: 4096 } } },
			{ model: budget, options: { reasoning: "high" as const, thinkingBudgets: { high: 1 } } },
			{ model: budget, options: { reasoning: "high" as const, thinkingBudgets: { high: Number.NaN } } },
			{ model: budget, options: { reasoning: "high" as const, thinkingBudgets: { high: 4096 }, maxTokens: 4096 } },
			{ model: budget, options: { reasoning: "high" as const, thinkingBudgets: { xhigh: 32768 } } },
		];
		for (const { model, options } of rejected) expect((await f.provider.streamSimple(model, context(), options).result()).stopReason).toBe("error");
		expect(f.requests).toHaveLength(1);
	});
});


describe("final review agent-loop safeguards", () => {
	it.each(["tool-first", "text-first", "missing-stop"])("rejects canonical-only per-block responses without executing or silently succeeding (%s)", async mode => {
		const f = await fixture(() => ({ close() {}, [Symbol.asyncIterator]: () => (async function* () {
			const blocks = [
				{ type: "tool_use", id: "canonical-a", name: "mcp__pi__read", input: { path: "a" } },
				{ type: "tool_use", id: "canonical-b", name: "mcp__pi__read", input: { path: "b" } },
			];
			if (mode === "text-first") yield canonical([{ type: "text", text: "not a complete response" }]);
			for (const block of blocks) {
				const frame = canonical([block]);
				if (mode === "missing-stop" && frame.type === "assistant") delete (frame.message as Partial<typeof frame.message>).stop_reason;
				yield frame;
			}
			yield { ...result, stop_reason: "max_tokens" } as SDKMessage;
		})() }));
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] },
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), opts) });
		await agent.prompt("canonical-only incomplete response");
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "Claude SDK interrupted or failed; reconcile any pending side effects before retrying" });
		expect(agent.state.messages.filter(m => m.role === "assistant").flatMap(m => m.content)).toEqual([]);
	});
	it.each(["partial", "partial-canonical", "full", "incomplete-json"])("never executes tools in a max_tokens response (%s)", async mode => {
		let starts = 0;
		const f = await fixture(() => { const first = ++starts === 1; return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
			if (!first) { yield* text("recovered after length"); return; }
			if (mode === "full") {
				yield { type: "assistant", parent_tool_use_id: null, message: { id: "truncated-full", stop_reason: "max_tokens", usage: {}, content: [{ type: "tool_use", id: "truncated", name: "mcp__pi__read", input: { path: "truncated" } }] } } as SDKMessage;
				yield result; return;
			}
			for (const event of mode === "partial-canonical" ? interleavedTools(["truncated"]) : tools(["truncated"])) {
				if (event.type === "stream_event" && event.event.type === "message_delta") yield* stop("max_tokens").slice(0, 1);
				else if (mode === "incomplete-json" && event.type === "stream_event" && event.event.type === "content_block_delta") {
					yield message({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"unfinished' } });
				} else yield event;
			}
			yield result;
		})() }; });
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] },
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), opts) });
		await agent.prompt("truncated tool");
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages).toContainEqual(expect.objectContaining({ role: "assistant", stopReason: "length", rawStopReason: "max_tokens", content: [expect.objectContaining({ type: "toolCall", id: "truncated" })] }));
		expect(agent.state.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "truncated", isError: true }));
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ text: "recovered after length" }] });
		expect(starts).toBe(2);
	});
	it.each(["tool_use", "end_turn"])("rejects malformed tool JSON with nontruncated %s without execution", async reason => {
		let reachedStopReason = false; let starts = 0; let seed = "";
		const f = await fixture(request => ({ close() {}, [Symbol.asyncIterator]: () => (async function* () {
			starts++;
			if (starts > 1) {
				seed = await readFile(request.options.resume!, "utf8");
				yield* text("independent prompt succeeded"); return;
			}
			yield start();
			yield message({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "malformed-json", name: "mcp__pi__read", input: {} } });
			yield message({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"unfinished' } });
			yield message({ type: "content_block_stop", index: 0 });
			reachedStopReason = true;
			yield* stop(reason); yield result;
		})() }));
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		let failedContext = context();
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] }, sessionId: "malformed-same-agent",
			streamFn: (model, ctx, opts) => {
				failedContext = structuredClone(normalizeContext(ctx));
				return f.provider.streamSimple(model, normalizeContext(ctx), opts);
			} });
		await agent.prompt("malformed tool arguments");
		expect(reachedStopReason).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", content: [{ type: "toolCall", id: "malformed-json" }] });
		const failedHistory = structuredClone(agent.state.messages);
		expect((await f.provider.streamSimple(f.model, failedContext, { sessionId: "malformed-same-agent" }).result()).errorMessage).toMatch(/Ambiguous previous/);
		expect(starts).toBe(1);
		await agent.prompt("independent next prompt");
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ text: "independent prompt succeeded" }] });
		expect(agent.state.messages.slice(0, failedHistory.length)).toEqual(failedHistory);
		expect(seed).not.toContain("malformed-json"); expect(seed).not.toContain('"tool_use"');
		expect(starts).toBe(2); expect(execute).not.toHaveBeenCalled();
	});
	it.each([undefined, null, 42, "", " ", "bad id", "bad\u0000id", "x".repeat(257)])("rejects the whole real-Agent batch after malformed MCP correlation %j without assistant.error", async id => {
		let client!: Client;
		let malformed: unknown;
		let pending: Promise<unknown> | undefined;
		const observed: SDKMessage[] = [];
		const f = await fixture(request => {
			client = new Client({ name: "malformed-correlation", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("No bridge");
				const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
				yield* tools(["valid-proposal", "sibling"]);
				yield* text("would otherwise complete");
			})() };
		});
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] },
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), { ...opts,
				onProviderStreamEvent: async event => {
					const sdk = event as SDKMessage; observed.push(sdk);
					if (sdk.type !== "stream_event" || sdk.event.type !== "message_stop" || pending) return;
					pending = client.callTool({ name: "read", arguments: { path: "valid-proposal" }, _meta: { "claudecode/toolUseId": "valid-proposal" } }).catch(error => error);
					await client.ping();
					malformed = await client.callTool({ name: "read", arguments: { path: "valid-proposal" },
						...(id === undefined ? {} : { _meta: { "claudecode/toolUseId": id } }) });
					// Wait for the already parked reply before provider disposal closes the transport.
					await pending;
				} }) });
		await agent.prompt("malformed MCP before message_stop");
		expect(malformed).toMatchObject({ isError: true });
		expect(await pending).toMatchObject({ isError: true, content: [{ text: "Pi bridge closed" }] });
		expect(observed.some(event => event.type === "assistant" && event.error)).toBe(false);
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(agent.state.messages.filter(message => message.role === "toolResult")).toEqual([]);
		expect(await readdir(f.root)).toEqual([]);
	});
	it.each(["name", "arguments"])("never executes or revives a registered tool after mismatched %s during message_stop observer", async mode => {
		let client!: Client; let starts = 0;
		const f = await fixture(request => {
			starts++; client = new Client({ name: "mismatch-after-registration", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("No bridge");
				const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
				if (starts > 1) { yield* text(); return; }
				yield* tools(["mismatch", "sibling"]); yield result;
			})() };
		});
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] }, sessionId: "mismatch-session",
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), { ...opts,
				onProviderStreamEvent: async event => {
					const sdk = event as SDKMessage;
					if (sdk.type !== "stream_event" || sdk.event.type !== "message_stop") return;
					const send = (name: string, path: string) => client.callTool({ name, arguments: { path }, _meta: { "claudecode/toolUseId": "mismatch" } });
					expect(await send(mode === "name" ? "bash" : "read", mode === "arguments" ? "wrong" : "mismatch")).toMatchObject({ isError: true });
					expect(await send("read", "mismatch")).toMatchObject({ isError: true });
				} }) });
		await agent.prompt("mismatched registered tool");
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(await readdir(f.root)).toEqual([]);
		const retry = await f.provider.streamSimple(f.model, normalizeContext({ tools: [tool], messages: [{ role: "user", content: "independent request", timestamp: 2 }] }), { sessionId: "mismatch-session" }).result();
		expect(retry.stopReason).toBe("stop"); expect(starts).toBe(2);
		expect(await readdir(f.root)).toEqual([]);
	});
	it.each(["cancel", "timeout"])("never executes a registered tool after %s while message_stop observer is held", async mode => {
		const cancel = new AbortController(); let client!: Client; let reply: Promise<unknown> | undefined;
		const f = await fixture(request => {
			client = new Client({ name: "cancel-after-registration", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("No bridge");
				const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
				yield* tools(["registered-cancel", "sibling-must-not-run"]);
				yield result;
			})() };
		});
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] },
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), { ...opts,
				onProviderStreamEvent: async event => {
					const sdk = event as SDKMessage;
					if (sdk.type === "stream_event" && sdk.event.type === "message_stop") {
						// content_block_stop has already registered the call. Wait until MCP acknowledges dispatch.
						reply = client.callTool({ name: "read", arguments: { path: "registered-cancel" }, _meta: { "claudecode/toolUseId": "registered-cancel" } }, undefined, mode === "cancel" ? { signal: cancel.signal } : { timeout: 25 }).catch(error => error);
						await client.ping(); if (mode === "cancel") cancel.abort(); await reply;
						// Let the server process notifications/cancelled before releasing the observer.
						await client.ping();
					}
				} }) });
		await agent.prompt("cancel registered tool");
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});
	it.each(["reasoning", "budget", "maxTokens"] as const)("rebuilds settled continuation when %s changes without replay", async change => {
		const requests: Options[] = []; const seeds: string[] = []; const inputs: unknown[] = [];
		const f = await fixture(request => {
			const number = requests.push(request.options);
			return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
				inputs.push((await request.prompt[Symbol.asyncIterator]().next()).value);
				seeds.push(request.options.resume ? await readFile(request.options.resume, "utf8") : "");
				if (number === 1) yield* tools(["once"]);
				yield* text("settled continuation");
			})() };
		});
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "settled tool result" }], details: undefined }));
		let turn = 0;
		const agent = new Agent({ initialState: { model: f.provider.getModels().find(m => m.id === "claude-haiku-4-5")!, thinkingLevel: "low", tools: [{ ...tool, label: "Read", execute }] }, sessionId: "options-change",
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), { ...opts, reasoning: change === "reasoning" && turn > 0 ? "high" : "low",
				thinkingBudgets: change === "budget" ? { low: turn > 0 ? 4096 : 2048 } : undefined,
				maxTokens: change === "maxTokens" && turn > 0 ? 32000 : 24000, onPayload: () => { turn++; } }) });
		await agent.prompt("one side effect");
		expect(execute).toHaveBeenCalledOnce(); expect(requests).toHaveLength(2);
		expect(seeds[1]).toContain('"tool_use"'); expect(seeds[1]).not.toContain("settled tool result");
		expect(inputs[1]).toMatchObject({ message: { content: [{ type: "tool_result", tool_use_id: "once", content: [{ text: "settled tool result" }] }] } });
		expect(requests[1]).toMatchObject(change === "maxTokens" ? { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" } } :
			{ thinking: { type: "enabled", budgetTokens: change === "reasoning" ? 16384 : 4096 } });
		expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ text: "settled continuation" }] });
	});
	it.each(["required", { type: "tool", name: "read" }])("rejects unsupported tool selection %j before query creation", async toolChoice => {
		const f = await fixture();
		const output = await f.provider.streamSimple(f.model, context(), { toolChoice: toolChoice as never }).result();
		expect(output.errorMessage).toMatch(/tool choice/i); expect(f.requests).toHaveLength(0);
	});
});

describe("explicit terminal tool handoff", () => {
	it.each(["refusal", "pause_turn", "end_turn", "unknown-terminal"])("never executes completed proposals with %s, including a real parked MCP call", async reason => {
		let queries = 0; let pending: Promise<unknown> | undefined;
		const f = await fixture(request => {
			queries++;
			const client = new Client({ name: "terminal-stop-regression", version: "1" });
			return { close: () => { void client.close(); }, [Symbol.asyncIterator]: () => (async function* () {
				const bridge = request.options.mcpServers!.pi;
				if (bridge.type !== "sdk") throw new Error("Missing SDK bridge");
				const [server, transport] = InMemoryTransport.createLinkedPair();
				await bridge.instance.connect(server); await client.connect(transport);
				pending = client.callTool({ name: "read", arguments: { path: "refused" }, _meta: { "claudecode/toolUseId": "refused" } });
				// Observe transport closure too; no injected assistant.error masks the stop boundary.
				void pending.catch(() => {});
				for (const event of tools(["refused"])) {
					if (event.type === "stream_event" && event.event.type === "message_delta") yield stop(reason)[0];
					else yield event;
				}
				yield result;
			})() };
		});
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: undefined }));
		const agent = new Agent({ initialState: { model: f.model, tools: [{ ...tool, label: "Read", execute }] },
			streamFn: (model, ctx, opts) => f.provider.streamSimple(model, normalizeContext(ctx), opts) });
		await agent.prompt("refused proposal");
		expect(execute).not.toHaveBeenCalled(); expect(queries).toBe(1);
		expect(agent.state.messages).toContainEqual(expect.objectContaining({ role: "assistant", stopReason: "error", rawStopReason: reason }));
		await Promise.allSettled([pending!]); expect(await readdir(f.root)).toEqual([]);
	});
});

describe("handoff reservation and destination history", () => {
	it.each(["original", "other"])("blocks original context replay while still parked, using session %s", async sessionId => {
		let queries = 0;
		const f = await fixture(() => { queries++; return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
			yield* tools(["already-handed-off"]); yield* text("correlated continuation");
		})() }; });
		const ctx = context();
		const first = await f.provider.streamSimple(f.model, ctx, { sessionId: "original" }).result();
		expect(first.stopReason).toBe("toolUse");
		expect((await f.provider.streamSimple(f.model, ctx, { sessionId }).result()).errorMessage).toMatch(/Ambiguous previous SDK attempt/);
		expect(queries).toBe(1);
		ctx.messages.push(first, ...correlated(first));
		expect((await f.provider.streamSimple(f.model, ctx, { sessionId: "original" }).result()).stopReason).toBe("stop");
		expect(queries).toBe(1);
	});
	it.each(["same", "model-switch", "provider-switch", "opaque-only-switch"])("reconstructs signed and redacted reasoning for %s without changing Pi history", async boundary => {
		let contents: unknown;
		const f = await fixture(request => ({ close() {}, [Symbol.asyncIterator]: () => (async function* () {
			const seed = (await readFile(request.options.resume!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
			contents = seed.find(entry => entry.type === "assistant")?.message.content;
			yield* text();
		})() }));
		const source: AssistantMessage = { role: "assistant", api: boundary === "provider-switch" ? "anthropic-messages" : f.model.api,
			provider: boundary === "provider-switch" ? "anthropic" : f.model.provider, model: f.model.id, timestamp: 2,
			content: [{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "signed-reasoning" },
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-reasoning", redacted: true }, { type: "text", text: "answer" }],
			usage: emptyUsage(), stopReason: "stop" };
		if (boundary === "opaque-only-switch") source.content = source.content.filter(block => block.type === "thinking" && block.redacted);
		const ctx = context(); ctx.messages.push(source, { role: "user", content: "next", timestamp: 3 });
		const before = structuredClone(ctx);
		const model = ["model-switch", "opaque-only-switch"].includes(boundary) ? f.provider.getModels().find(model => model.id !== f.model.id)! : f.model;
		expect((await f.provider.streamSimple(model, ctx).result()).stopReason).toBe("stop");
		expect(contents).toEqual(boundary === "opaque-only-switch" ? undefined : boundary === "same" ? [
			{ type: "thinking", thinking: "visible reasoning", signature: "signed-reasoning" },
			{ type: "redacted_thinking", data: "opaque-reasoning" }, { type: "text", text: "answer" },
		] : [{ type: "text", text: "visible reasoning" }, { type: "text", text: "answer" }]);
		expect(ctx).toEqual(before);
	});
});
