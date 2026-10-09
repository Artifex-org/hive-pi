import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { installDriver } from "../extensions/agenda/driver.ts";
import type { Policy } from "../extensions/agenda/policy.ts";

it("runs one agenda continuation at the native before-settle boundary", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-agenda-native-"));
	const faux = fauxProvider({
		provider: "agenda-native-test",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }],
	});
	faux.setResponses([fauxAssistantMessage("First pass complete."), fauxAssistantMessage("Continuation complete.")]);
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const model = faux.getModel();
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const boundaryIdle: boolean[] = [];
	const boundarySignal: boolean[] = [];
	let injected = false;
	const policy: Policy = {
		name: "native-fixture",
		decide: () => {
			if (injected) return null;
			injected = true;
			return {
				name: "native-fixture",
				status: "testing native settle",
				run: async () => ({ metric: { outcome: "pass", value: 1 }, inject: "Continue once." }),
			};
		},
	};
	const extension: ExtensionFactory = (pi) => {
		installDriver(pi, { policies: [policy] });
		pi.on("agent_before_settle", (_event, ctx) => {
			boundaryIdle.push(ctx.isIdle());
			boundarySignal.push(ctx.signal !== undefined);
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [extension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: runtime,
		model,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
	});
	const settled: unknown[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_settled") settled.push(event);
	});
	try {
		await session.bindExtensions({ mode: "rpc" });
		await session.prompt("Finish the task.");

		expect(faux.state.callCount).toBe(2);
		expect(boundaryIdle).toEqual([false, false]);
		// Core model activity has ended: human-abort veto belongs to AgentSession,
		// not an active core signal. Do not claim cancelable probe work here.
		expect(boundarySignal).toEqual([false, false]);
		expect(session.messages.filter((message) => message.role === "custom" && message.customType === "agenda")).toHaveLength(1);
		expect(settled).toHaveLength(1);
	} finally {
		unsubscribe();
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);

it("offers milestone advice before the native final report without starving settle checks", async () => {
	const { Type } = await import("typebox");
	const { createConductorAdvicePolicy } = await import("../extensions/agenda/conductor.ts");
	const { createConductor, withStage } = await import("../extensions/agenda/conductor-state.ts");
	const cwd = await mkdtemp(join(tmpdir(), "pi-advice-native-"));
	const faux = fauxProvider({
		provider: "advice-native-test",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }],
	});
	const commit = fauxAssistantMessage("", { stopReason: "toolUse" });
	commit.content = [{ type: "toolCall", id: "commit", name: "fixture_code", arguments: {} }];
	faux.setResponses([commit, fauxAssistantMessage("Delivery complete.")]);
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let item = withStage(createConductor("c", 0), "execute", 0);
	let checks = 0;
	let adviceBeforeReport = false;
	let agentStarts = 0;
	const extension: ExtensionFactory = pi => {
		pi.registerTool({ name: "bash", label: "fixture commit", description: "Emit a successful commit result", parameters: Type.Object({ command: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "[work abc1234] change" }], details: undefined }) });
		pi.registerTool({ name: "fixture_code", label: "nested fixture", description: "Call bash through the native nested-tool API", parameters: Type.Object({}),
			execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool("bash", { command: "git commit -m change" })).result });
		const advice = createConductorAdvicePolicy({ current: () => item, commit: next => { item = next; },
			goal: () => ({ state: "active" } as import("../extensions/agenda/goal-state.ts").GoalItem), enabled: () => true, requestPlanMode: () => {} });
		installDriver(pi, { turnPolicies: [advice], policies: [advice, { name: "gate", decide: () => {
			checks++; return null;
		} }] });
		pi.on("agent_start", () => { agentStarts++; });
		pi.on("turn_start", (_event, ctx) => {
			if (faux.state.callCount === 1) adviceBeforeReport = ctx.sessionManager.getBranch().some(entry =>
				entry.type === "custom_message" && entry.customType === "agenda" && typeof entry.content === "string" && entry.content.includes("first commit or PR opening"));
		});
	};
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(),
		settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), noTools: "builtin" });
	try {
		await session.bindExtensions({ mode: "rpc" });
		await session.prompt("Implement HIV-3838 with tests and deliver one PR.");
		expect(faux.state.callCount).toBe(2);
		expect(agentStarts).toBe(1);
		expect(adviceBeforeReport).toBe(true);
		expect(item.stage).toBe("verify");
		expect(checks).toBe(1);
		expect(session.messages.filter(message => message.role === "custom" && message.customType === "agenda")).toHaveLength(1);
	} finally {
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);
