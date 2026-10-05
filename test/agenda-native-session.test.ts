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
