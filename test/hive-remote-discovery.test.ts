import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createToolSearchExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import remote from "../extensions/hive-remote/index.ts";
import { loadConfig } from "../extensions/hive-remote/config.ts";
import loadout from "../extensions/loadout/index.ts";

it.each(["load_tools", "tool_search"])("discovers disabled grants through native %s without model or network calls", async (loader) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-discovery-"));
	const faux = fauxProvider({
		provider: "workspace-discovery-test",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }],
	});
	const fetch = vi.fn(() => { throw new Error("disabled grants must not reach the network"); });
	const resolveAuth = vi.fn(() => { throw new Error("disabled grants must not resolve credentials"); });
	vi.stubGlobal("fetch", fetch);
	try {
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["load_tools", "tool_search"], retry: { enabled: false }, compaction: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => remote(pi, { loadConfig: () => ({ ...loadConfig(), enabled: false, allowAddWorkspace: false }), resolveAuth }),
				loadout,
				createToolSearchExtension(),
			],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			await session.bindExtensions({ mode: "rpc" });
			for (const name of ["request_workspace", "list_workspace_catalog"]) {
				session.setActiveToolsByName(["load_tools", "tool_search"]);
				expect(session.getAllTools().find((tool) => tool.name === name)?.exposure).toBe("deferred");
				expect(session.getActiveToolNames()).not.toContain(name);
				const tool = session.agent.state.tools.find((entry) => entry.name === loader);
				expect(tool).toBeDefined();
				await tool!.execute(`discover-${name}`, loader === "load_tools" ? { names: [name] } : { query: name });
				expect(session.getActiveToolNames()).toContain(name);
				const grant = session.agent.state.tools.find((entry) => entry.name === name);
				const result = await grant!.execute(`call-${name}`, name === "request_workspace" ? { repo: "hive" } : {});
				expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("allowAddWorkspace is off") })]);
			}
			expect(faux.state.callCount).toBe(0);
			expect(fetch).not.toHaveBeenCalled();
			expect(resolveAuth).not.toHaveBeenCalled();
		} finally {
			session.dispose();
		}
	} finally {
		vi.unstubAllGlobals();
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);
