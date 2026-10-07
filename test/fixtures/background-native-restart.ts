import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import background from "../../extensions/background/index.ts";
import { recoverJobs } from "../../extensions/background/journal.ts";

// No overrides of appendEntry/sendMessage: exercise Pi's native queues and
// settling boundary, then recover in a separate process and reload natively.
const [stage, cwd, file] = process.argv.slice(2);
const manager = stage === "read" ? SessionManager.open(file) : SessionManager.create(cwd, cwd);
if (stage !== "read") manager.appendMessage({ role: "user", content: "Check", timestamp: Date.now() });
const faux = fauxProvider({ provider: "background-native-restart", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1000 }] });
faux.setResponses([fauxAssistantMessage("Shall I proceed?")]);
const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider);
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
let ownerApi: ExtensionAPI;
let saved: Buffer | undefined;
let shutdowns = 0;
const errors: string[] = [];
const extension: ExtensionFactory = (pi) => {
	ownerApi = pi;
	if (stage === "notice-failure") pi.on("agent_settled", () => {
		if (saved) return;
		const path = manager.getSessionFile()!;
		saved = readFileSync(path); rmSync(path); mkdirSync(path);
	});
	background(pi);
	if (stage === "read") return;
	let sent = false;
	const landAndCrash = () => {
		if (sent) return;
		sent = true;
		const identity = { id: "sub-1", sessionId: manager.getSessionId(), executionId: "native-execution" };
		pi.events.emit("background.job", { ...identity, action: "start", what: "native boundary", kind: "subagent", detail: "read-only fixture" });
		pi.events.emit("background.job", { ...identity, action: "output", chunk: "native retained evidence" });
		pi.events.emit("background.job", { ...identity, action: "finish", status: "done", exitCode: 0 });
		if (manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "background")) {
			console.error("notice already persisted; did not exercise pending queue"); process.exit(2);
		}
		if (stage !== "notice-failure") process.kill(process.pid, "SIGKILL");
	};
	if (stage === "held" || stage === "notice-failure") pi.on("agent_before_settle", landAndCrash);
	else pi.on("message_start", (event) => { if (event.message.role === "assistant") landAndCrash(); });
};
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(), settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
await session.bindExtensions({ mode: "rpc", shutdownHandler: () => { shutdowns++; }, onError: (error) => { errors.push(error.error); } });
if (stage !== "read") {
	process.send?.({ file: manager.getSessionFile() });
	await session.prompt("Finish the check.");
	if (stage === "notice-failure") {
		if (!saved) throw new Error("native failed-send boundary not reached");
		const path = manager.getSessionFile()!;
		const ghost = manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "background");
		rmSync(path, { recursive: true }); writeFileSync(path, saved);
		// This sender failed asynchronously (the extension could not catch it).
		// Subsequent journaling must stop BEFORE a child of its memory-only id is written.
		ownerApi!.events.emit("background.job", { id: "sub-2", sessionId: manager.getSessionId(), executionId: "second", action: "start", what: "blocked write", kind: "subagent", detail: "read-only fixture" });
		await session.waitForIdle();
		console.log(JSON.stringify({ ghost, failedSend: errors.some((error) => error.includes("EISDIR")), shutdowns, unchanged: readFileSync(path).equals(saved), calls: faux.state.callCount }));
		session.dispose();
	} else { console.error("crash boundary not reached"); process.exit(2); }
} else {
	await session.waitForIdle();
	const notices = () => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "background");
	const beforeReload = notices().length;
	await session.reload();
	await session.waitForIdle();
	const recovered = recoverJobs(manager.getBranch(), manager.getSessionId())[0];
	console.log(JSON.stringify({ beforeReload, afterReload: notices().length, calls: faux.state.callCount, output: recovered.job.output, executionId: recovered.executionId }));
	session.dispose();
}
