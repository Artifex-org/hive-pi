import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type Api, type Model, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import cybersecurityFallback from "../extensions/cybersecurity-fallback/index.ts";
import { FALLBACK_MODEL, FALLBACK_PROVIDER, isCybersecurityError } from "../extensions/cybersecurity-fallback/policy.ts";
import { createFakePi } from "./fake-pi.ts";
import { emptyJsonRunState, foldJsonLine } from "../extensions/harness/json-protocol.ts";

// Representative provider error strings; no live provider refusal is required.
const CYBER_ERROR = '400 {"error":{"message":"Request blocked by cybersecurity safety policy"}}';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", api: "openai-completions", provider: "openai-codex", model: "fixture", timestamp: Date.now(),
		content: [], stopReason: "error", errorMessage: CYBER_ERROR,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
		...overrides,
	};
}

describe("cybersecurity error classification", () => {
	it.each([
		["openai", "fixture", CYBER_ERROR],
		["openai-codex", "fixture", 'Error: {"code":"cyber_safety","message":"Request rejected"}'],
		["openai-codex", "fixture", '{"error":{"code":"cyber_safety_violation"}}'],
		["anthropic", "fixture", '{"error":{"type":"cybersecurity_policy_violation"}}'],
		["anthropic", "fixture", "Request refused for cyber-security reasons"],
		["azure-openai-responses", "fixture", "Flagged by Cyber Security policy"],
		["openrouter", "anthropic/claude-fixture", CYBER_ERROR],
		["openrouter", "openai/gpt-fixture", CYBER_ERROR],
	])("accepts %s/%s cybersecurity errors", (provider, model, errorMessage) => {
		expect(isCybersecurityError(message({ provider, model, errorMessage }))).toBe(true);
	});
	it.each([
		"429 Rate limit exceeded", "401 invalid API key", "quota exceeded", "context window exceeded",
		"Request blocked by content filtering policy", "Potential usage policy violation",
		"cybersecurity service unavailable", undefined,
	])("ignores unrelated errors: %s", errorMessage => {
		expect(isCybersecurityError(message({ errorMessage }))).toBe(false);
	});
	it("ignores prose, cancellation, and other vendors even with a matching error string", () => {
		for (const stopReason of ["stop", "aborted", "toolUse"] as const) {
			expect(isCybersecurityError(message({ stopReason, content: [{ type: "text", text: CYBER_ERROR }] }))).toBe(false);
		}
		for (const [provider, model] of [["zai", FALLBACK_MODEL], ["xai", "grok-fixture"], ["openrouter", "deepseek/fixture"]]) {
			expect(isCybersecurityError(message({ provider, model }))).toBe(false);
		}
	});
});

interface FixtureOptions {
	provider?: string;
	error?: string;
	fallbackError?: boolean;
	credentials?: boolean;
	toolFirst?: boolean;
	retry?: boolean;
	extraExtension?: ExtensionFactory;
}

async function fixture(options: FixtureOptions = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cyber-"));
	const provider = options.provider ?? "openai-codex";
	const authPath = join(cwd, "auth.json");
	await writeFile(authPath, JSON.stringify({
		[provider]: { type: "api_key", key: "fixture-source" },
		...(options.credentials === false ? {} : { zai: { type: "api_key", key: "fixture-fallback" } }),
	}));
	const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	// Verify the fallback is native; registering the offline transport must not
	// conceal a typo or require a workstation models.json entry.
	expect(runtime.getModel(FALLBACK_PROVIDER, FALLBACK_MODEL)?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
	const requests: { provider: string; context: Context }[] = [];
	let sourceCalls = 0;
	let writes = 0;
	for (const [id, modelId] of [[provider, "fixture"], [FALLBACK_PROVIDER, FALLBACK_MODEL]]) {
		runtime.registerProvider(id, {
			api: "openai-completions", baseUrl: "https://example.invalid",
			...(id === provider ? { apiKey: "fixture-source" } : {}),
			models: [{ id: modelId, name: modelId, reasoning: false, input: ["text"], cost, contextWindow: 1000000, maxTokens: 1000 }],
			streamSimple(model, context) {
				requests.push({ provider: id, context: structuredClone(context) });
				const toolTurn = id === provider && ++sourceCalls === 1 && options.toolFirst;
				const failed = id === provider && !toolTurn || id === FALLBACK_PROVIDER && options.fallbackError;
				const result = message({
					provider: id, model: model.id, stopReason: toolTurn ? "toolUse" : failed ? "error" : "stop",
					errorMessage: failed ? options.error ?? CYBER_ERROR : undefined,
					content: toolTurn ? [{ type: "toolCall", id: "write-once", name: "fixture_write", arguments: {} }]
						: failed ? [{ type: "text", text: "Partial response" }, { type: "toolCall", id: "never-execute", name: "fixture_write", arguments: {} }]
							: [{ type: "text", text: "finished" }],
				});
				const stream = createAssistantMessageEventStream();
				if (result.stopReason === "error") stream.push({ type: "error", reason: "error", error: result });
				else if (result.stopReason === "stop" || result.stopReason === "toolUse") stream.push({ type: "done", reason: result.stopReason, message: result });
				stream.end(result);
				return stream;
			},
		});
	}
	// Registration refreshes asynchronously; finish the offline auth snapshot
	// before a fast fixture response reaches setModel's configured-auth gate.
	await runtime.refresh({ allowNetwork: false });
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 }, compaction: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [cybersecurityFallback, ...(options.extraExtension ? [options.extraExtension] : [])],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, modelRuntime: runtime, model: runtime.getModel(provider, "fixture"), settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(), tools: ["fixture_write"], customTools: [{
			name: "fixture_write", label: "fixture write", description: "Record a completed write", parameters: Type.Object({}),
			async execute() { writes++; return { content: [{ type: "text", text: "saved" }], details: {} }; },
		}],
	});
	let wireState = emptyJsonRunState();
	const extensionErrors: unknown[] = [];
	session.subscribe(event => {
		wireState = foldJsonLine(wireState, JSON.stringify(event));
	});
	await session.bindExtensions({ mode: "print", onError: error => { extensionErrors.push(error); } });
	return { session, runtime, settingsManager, requests, wireState: () => wireState, extensionErrors, writes: () => writes, async close() { session.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}

describe("recovery ownership", () => {
	const failed = message();
	const source = { provider: failed.provider, id: failed.model } as Model<Api>;
	const event = { type: "agent_before_settle", outcome: "error" };
	const branch = [{ type: "message", message: failed }];

	it("reports a missing model without switching or continuing", async () => {
		const pi = createFakePi();
		cybersecurityFallback(pi.api);
		const select = vi.spyOn(pi.api, "setModel");
		await pi.emit(event, { branch, model: source, modelRegistry: { find: () => undefined } });
		expect(select).not.toHaveBeenCalled();
		expect(pi.notifications.at(-1)?.message).toContain("not in the model registry");
		expect(pi.messages).toHaveLength(0);
	});

	it.each(["pending input", "cancellation", "manual switch"])("does not take over %s", async reason => {
		const pi = createFakePi();
		cybersecurityFallback(pi.api);
		const select = vi.spyOn(pi.api, "setModel");
		await pi.emit(event, {
			branch, model: reason === "manual switch" ? { ...source, id: "another-model" } : source,
			pendingMessages: reason === "pending input",
			signal: reason === "cancellation" ? AbortSignal.abort() : undefined,
		});
		expect(select).not.toHaveBeenCalled();
		expect(pi.messages).toHaveLength(0);
	});

	it("reports a manual selection that can no longer be authenticated without continuing", async () => {
		const pi = createFakePi();
		cybersecurityFallback(pi.api);
		const selected = { ...source };
		const manual = { ...source, id: "manual-selection" };
		const select = vi.spyOn(pi.api, "setModel").mockImplementationOnce(async model => {
			await pi.emit({ type: "model_select", model: manual });
			Object.assign(selected, model);
			return true;
		}).mockResolvedValueOnce(false);
		const results = await pi.emit(event, { branch, model: selected, modelRegistry: { find: () => ({ provider: "zai", id: FALLBACK_MODEL }) } });
		expect(select).toHaveBeenCalledTimes(2);
		expect(results[0]).toBeUndefined();
		expect(pi.notifications.at(-1)?.message).toContain("Could not restore the manual model selection");
	});

	it("cancels continuation when input arrives during model selection", async () => {
		const pi = createFakePi();
		cybersecurityFallback(pi.api);
		const selected = { ...source };
		vi.spyOn(pi.api, "setModel").mockImplementation(async model => {
			Object.assign(selected, model);
			await pi.emit({ type: "input", source: "interactive" });
			return true;
		});
		const results = await pi.emit(event, { branch, model: selected, modelRegistry: { find: () => ({ provider: "zai", id: FALLBACK_MODEL }) } });
		expect(selected.id).toBe(FALLBACK_MODEL);
		expect(results[0]).toBeUndefined();
		expect(pi.messages).toHaveLength(0);
	});
});

describe("native Pi recovery lifecycle", () => {
	beforeEach(() => vi.stubEnv("ZAI_API_KEY", ""));
	afterEach(() => vi.unstubAllEnvs());
	it.each(["openai-codex", "anthropic"])("switches %s, continues once, and keeps GLM selected without changing defaults", async provider => {
		const f = await fixture({ provider, toolFirst: true });
		try {
			await f.session.prompt("Complete the task.");
			expect(f.requests.map(request => request.provider)).toEqual([provider, provider, "zai"]);
			expect(f.writes()).toBe(1); // completed tool not repeated; failed-stream tool never executed
			expect(f.requests.at(-1)?.context.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "write-once" }));
			expect(f.session.model?.id).toBe(FALLBACK_MODEL);
			expect(f.wireState().stopReason).toBe("stop");
			expect(f.wireState().errorMessage).toBeUndefined();
			expect(f.extensionErrors).toEqual([]);
			expect(f.session.messages.filter(m => m.role === "user")).toHaveLength(1);
			expect(f.session.messages.filter(m => m.role === "assistant" && m.stopReason === "error")).toHaveLength(1);
			expect(f.session.messages.filter(m => m.role === "custom" && m.customType === "cybersecurity-fallback")).toHaveLength(1);
			expect(f.settingsManager.getDefaultProvider()).toBeUndefined();
			await f.session.prompt("Next task.");
			expect(f.requests.at(-1)?.provider).toBe("zai");
		} finally { await f.close(); }
	});
	it("runs after built-in retries, not alongside them", async () => {
		const f = await fixture({ retry: true, error: "503: Request blocked by cybersecurity safety policy" });
		try {
			await f.session.prompt("Complete the task.");
			expect(f.requests.map(request => request.provider)).toEqual(["openai-codex", "openai-codex", "zai"]);
		} finally { await f.close(); }
	});
	it("stops if GLM also fails instead of looping or changing providers again", async () => {
		const f = await fixture({ fallbackError: true });
		try {
			await f.session.prompt("Complete the task.");
			expect(f.requests.map(request => request.provider)).toEqual(["openai-codex", "zai"]);
			expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		} finally { await f.close(); }
	});
	it("leaves the original error and model intact when fallback authentication is unavailable", async () => {
		const f = await fixture({ credentials: false });
		try {
			await f.session.prompt("Complete the task.");
			expect(f.requests).toHaveLength(1);
			expect(f.session.model?.provider).toBe("openai-codex");
			expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", errorMessage: CYBER_ERROR });
		} finally { await f.close(); }
	});
	it("does not recover generic policy errors", async () => {
		const f = await fixture({ error: "Request blocked by content filtering policy" });
		try {
			await f.session.prompt("Complete the task.");
			expect(f.requests).toHaveLength(1);
			expect(f.session.model?.provider).toBe("openai-codex");
		} finally { await f.close(); }
	});
	it("preserves a manual model selection made while fallback authentication is pending", async () => {
		const f = await fixture();
		const originalCheck = f.runtime.checkAuth.bind(f.runtime);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { entered = resolve; });
		let delayed = false;
		vi.spyOn(f.runtime, "checkAuth").mockImplementation(async (provider, options) => {
			if (provider === "zai" && !delayed) { delayed = true; entered(); await gate; }
			return originalCheck(provider, options);
		});
		try {
			const run = f.session.prompt("Complete the task.");
			await started;
			const manual = { ...f.session.model!, id: "manual-selection" };
			await f.session.setModel(manual);
			release();
			await run;
			expect(f.session.model).toBe(manual);
			expect(f.requests).toHaveLength(1);
		} finally { release(); await f.close(); }
	});
	it("does not continue if aborted during fallback authentication, even though selection has begun", async () => {
		const f = await fixture();
		const originalCheck = f.runtime.checkAuth.bind(f.runtime);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { entered = resolve; });
		vi.spyOn(f.runtime, "checkAuth").mockImplementation(async (provider, options) => {
			if (provider === "zai") { entered(); await gate; }
			return originalCheck(provider, options);
		});
		try {
			const run = f.session.prompt("Complete the task.");
			await started;
			const abort = f.session.abort();
			release();
			await Promise.all([run, abort]);
			expect(f.requests).toHaveLength(1);
			// Pi authenticates before switching, and cannot cancel setModel.
			expect(f.session.model?.id).toBe(FALLBACK_MODEL);
		} finally { release(); await f.close(); }
	});
	it("respects an abort at the actionable settlement boundary", async () => {
		const f = await fixture({ extraExtension(pi) { pi.on("agent_before_settle", (_event, ctx) => { ctx.abort(); }); } });
		try {
			await f.session.prompt("Complete the task.");
			expect(f.requests).toHaveLength(1);
		} finally { await f.close(); }
	});
});
