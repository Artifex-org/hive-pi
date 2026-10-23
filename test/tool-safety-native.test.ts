import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

it("observes direct and nested shell tools in the pinned native runtime before execution", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-shell-safety-native-"));
	const oldHome = process.env.HOME;
	process.env.HOME = cwd;
	const classify = vi.fn(async () => ({ api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
		stopReason: "stop" as const, answers: { risk: { type: "choice" as const, choice: "destructive", confidence: 0.95, probabilities: { destructive: 0.95, unknown: 0.05 } } },
		usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }));
	let dispose: (() => void) | undefined;
	try {
		const dir = join(cwd, ".pi", "agent", "hive-telemetry"); await mkdir(dir, { recursive: true });
		for (const file of ["typesafe", "tool-safety"]) await writeFile(join(dir, `${file}.config.json`), '{"enabled":true}');
		const guards = (await import("../extensions/guards-bridge.ts")).default;
		const faux = fauxProvider({ provider: "shell-safety-test", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }] });
		const tools = fauxAssistantMessage("", { stopReason: "toolUse" });
		tools.content = [
			{ type: "toolCall", id: "direct", name: "bash", arguments: { command: "rm -rf ./direct-fixture" } },
			{ type: "toolCall", id: "nested", name: "fixture_nested", arguments: {} },
		];
		faux.setResponses([tools, fauxAssistantMessage("Done.")]);
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const observed: { name: string; parent?: string }[] = [];
		const executed: string[] = [];
		const extension: ExtensionFactory = pi => {
			pi.registerProvider("typesafe", { apiKey: "fixture-not-a-real-key", models: [{
				type: "classifier", id: "jev-latest", name: "Jev fixture", api: "typesafe-system-one", baseUrl: "https://example.invalid",
				contextWindow: 64000, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}], classifiers: { "typesafe-system-one": { classify } } });
			guards(pi);
			pi.on("tool_call", event => { if (event.toolName === "bash" || event.toolName === "background_bash") observed.push({ name: event.toolName, parent: event.parentToolCallId }); });
			for (const name of ["bash", "background_bash"]) pi.registerTool({ name, label: name, description: "Stub shell; never executes a command", parameters: Type.Object({ command: Type.String() }),
				execute: async (_id, args) => {
					expect(classify.mock.calls.some(call => JSON.stringify(call).includes(args.command))).toBe(true);
					executed.push(args.command); return { content: [{ type: "text", text: '{"ok":true}' }], details: undefined };
				} });
			pi.registerTool({ name: "fixture_nested", label: "Nested shell fixture", description: "Use native nested dispatch, like codemode", parameters: Type.Object({}),
				execute: async (_id, _args, _signal, _update, ctx) => {
					for (const name of ["bash", "background_bash"]) {
						const nested = await ctx.executeTool(name, { command: `rm -rf ./nested-${name}` });
						expect(nested.result.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
					}
					return { content: [{ type: "text", text: "nested complete" }], details: undefined };
				} });
		};
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(), settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), noTools: "builtin" });
		dispose = () => session.dispose();
		await session.bindExtensions({ mode: "rpc" }); await session.prompt("Run the stub shell fixtures.");
		expect(classify).toHaveBeenCalledTimes(3); expect(executed).toHaveLength(3);
		expect(observed).toEqual([{ name: "bash", parent: undefined }, { name: "bash", parent: "nested" }, { name: "background_bash", parent: "nested" }]);
		expect(session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "tool-safety")).toHaveLength(3);
	} finally {
		dispose?.();
		if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);
