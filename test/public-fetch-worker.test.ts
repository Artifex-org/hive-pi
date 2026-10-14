/** Real SDK resource loading and scripted tool calls; Hive HTTP/model are mocked, not live child retrieval. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../extensions/harness/roles.ts";
import { buildSubagentWorkerArgs, WORKER_BUILTIN_MCP_EXTENSIONS } from "../extensions/subagent/worker.ts";

const URL = "https://example.com/fixture.txt";
const source = { url: URL, final_url: URL, status: 200, content_type: "text/plain", bytes: 7, sha256: "b".repeat(64), truncated: false, content: "fixture" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function worker(roleName: string) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-public-fetch-worker-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
	vi.stubEnv("PI_AGENDA_WORKER", "1");
	vi.stubEnv("PI_SUBAGENT_FAST", "0");
	vi.stubEnv("HIVE_URL", "https://hive.example.com");
	vi.stubEnv("HIVE_TOKEN", "scoped-worker-test");
	// Stage existing knowledge registration without touching operator profiles/network.
	vi.stubEnv("HIVE_TELEMETRY_URL", "https://hive.example.com");
	vi.stubEnv("HIVE_TELEMETRY_TOKEN", "scoped-worker-test");
	const role = discoverAgents(cwd, "user").agents.find((role) => role.name === roleName);
	expect(role?.source).toBe("package");
	if (!role) throw new Error(`Missing shipped role ${roleName}`);
	const argv = buildSubagentWorkerArgs(role.model, role.tools, role.opMode);
	// Pass the worker's actual startup options to the SDK (same options as the CLI).
	const paths = argv.filter((_arg, index) => argv[index - 1] === "-e");
	for (const builtin of WORKER_BUILTIN_MCP_EXTENSIONS) expect(paths).not.toContain(builtin);
	const grants = argv[argv.indexOf("--tools") + 1].split(",");
	const faux = fauxProvider({ provider: "public-fetch-worker-test", models: [{ id: "scripted", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }] });
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
		noExtensions: argv.includes("--no-extensions"), additionalExtensionPaths: paths,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPromptOverride: () => role.systemPrompt,
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(),
		settingsManager, resourceLoader, tools: grants, sessionManager: SessionManager.inMemory() });
	await session.bindExtensions({ mode: "json" });
	return { session, faux, grants, close: async () => { session.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}

it.each(["research", "retriever"])("%s discovers and invokes the granted broker tool through real SDK startup", async (role) => {
	const w = await worker(role);
	try {
		expect(w.session.getActiveToolNames().sort()).toEqual(w.grants.sort());
		expect(w.session.getCallableToolNames()).toContain("fetch_public_url");
		expect(w.session.getAllTools().find((tool) => tool.name === "fetch_public_url")?.description).toContain("untrusted data");
		for (const absent of ["codemode", "tool_search", "fetch_content", "bash", "write"]) expect(w.session.getActiveToolNames()).not.toContain(absent);
		const http = vi.fn().mockResolvedValue(new Response(JSON.stringify(source))); vi.stubGlobal("fetch", http);
		w.faux.setResponses([
			(context) => {
				const system = context.messages.find((message) => message.role === "system");
				expect(system).toMatchObject({ toolsAdded: expect.arrayContaining([expect.objectContaining({ name: "fetch_public_url" })]) });
				return fauxAssistantMessage(fauxToolCall("fetch_public_url", { url: URL }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Scripted fixture read complete."),
		]);
		await w.session.prompt("Read the public fixture as data.");
		const message = w.session.messages.find((message) => message.role === "toolResult" && message.toolName === "fetch_public_url");
		expect(message, JSON.stringify(w.session.messages.filter(message => message.role === "assistant"))).toMatchObject({ role: "toolResult", isError: false, details: source });
		expect(http).toHaveBeenCalledOnce();
		expect(http.mock.calls[0][0]).toBe("https://hive.example.com/api/v1/public/fetch");
		expect(JSON.parse(http.mock.calls[0][1].body)).toEqual({ url: URL });
	} finally { await w.close(); }
}, 30_000);

it("an ungranted code-reviewer cannot discover, activate or invoke the broker tool", async () => {
	const w = await worker("code-reviewer");
	try {
		expect(w.session.getActiveToolNames().sort()).toEqual(w.grants.sort());
		expect(w.session.getAllTools().map((tool) => tool.name)).not.toContain("fetch_public_url");
		expect(w.session.getCallableToolNames()).not.toContain("fetch_public_url");
		w.session.setActiveToolsByName([...w.grants, "fetch_public_url"]);
		expect(w.session.getActiveToolNames()).not.toContain("fetch_public_url");
		const http = vi.fn(); vi.stubGlobal("fetch", http);
		w.faux.setResponses([fauxAssistantMessage(fauxToolCall("fetch_public_url", { url: URL }), { stopReason: "toolUse" }), fauxAssistantMessage("Denied.")]);
		await w.session.prompt("Attempt the ungranted tool.");
		expect(w.session.messages.find((message) => message.role === "toolResult")).toMatchObject({ isError: true });
		expect(http).not.toHaveBeenCalled();
	} finally { await w.close(); }
}, 30_000);

it.each(["missing scoped config", "broker refusal"])("research receives an actual failed tool result for %s", async (failure) => {
	const w = await worker("research");
	try {
		const http = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "exact hostname:443 consent required", source: { url: URL } }), { status: 422 })); vi.stubGlobal("fetch", http);
		if (failure === "missing scoped config") vi.stubEnv("HIVE_TOKEN", "");
		w.faux.setResponses([fauxAssistantMessage(fauxToolCall("fetch_public_url", { url: URL }), { stopReason: "toolUse" }), fauxAssistantMessage("Refused, no bypass.")]);
		await w.session.prompt("Read the fixture.");
		const message = w.session.messages.find((message) => message.role === "toolResult");
		expect(message).toMatchObject({ isError: true });
		if (failure === "missing scoped config") expect(http).not.toHaveBeenCalled(); else expect(http).toHaveBeenCalledOnce();
	} finally { await w.close(); }
}, 30_000);
