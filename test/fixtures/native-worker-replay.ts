import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Install before importing Pi: its raw-output guard captures stdout.write.
// Serialize split writes so later events cannot interleave inside a JSON record.
const write = process.stdout.write.bind(process.stdout);
let pending = Promise.resolve();
process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
	const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8") : Buffer.from(chunk);
	const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	pending = pending.then(async () => {
		const middle = Math.floor(bytes.length / 2);
		write(bytes.subarray(0, middle));
		await delay(2);
		write(bytes.subarray(middle), done);
	});
	return true;
}) as typeof process.stdout.write;

const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, runPrintMode, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("fixture requires isolated PI_CODING_AGENT_DIR");
writeFileSync(join(cwd, "child.pid"), String(process.pid));
const mode = process.env.NATIVE_WORKER_FIXTURE_MODE;
let receivedSigterm = false;
process.once("SIGTERM", () => { receivedSigterm = true; });
const args = process.argv.slice(2);
if (!args.includes("--no-session") || !args.includes("--no-extensions") || args[args.indexOf("--mode") + 1] !== "json") throw new Error("unexpected worker argv");
if (mode === "startup-failure") { process.stderr.write("fixture startup failure\n"); process.exit(1); }
const toolNames = args[args.indexOf("--tools") + 1]?.split(",");
const task = args.at(-1)!;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("network prohibited in native replay fixture"); };
const faux = fauxProvider({
	provider: "native-worker-fixture",
	models: [{ id: "native-worker-fixture", name: "native-worker-fixture", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }],
	tokensPerSecond: mode === "cancel" ? 100 : undefined,
	tokenSize: { min: 8, max: 8 },
});
const failed = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" });
if (mode === "retry" || mode === "exhausted") {
	faux.setResponses(mode === "retry" ? [failed(), fauxAssistantMessage("Recovered after native retry.")] : [failed(), failed(), failed()]);
} else {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "evidence.txt" }), { stopReason: "toolUse" }),
		(context) => {
			const toolResult = context.messages.find((message) => message.role === "toolResult");
			if (!toolResult || !JSON.stringify(toolResult).includes("native-tool-evidence")) throw new Error("native read did not return fixture evidence");
			return fauxAssistantMessage(mode === "cancel" ? "Partial streaming response. ".repeat(200) : "Offline native worker read the evidence.");
		},
	]);
}
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider);
const settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 5 }, compaction: { enabled: false }, cacheWarming: "off" });
const host = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
	const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime, settingsManager: settings, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
			pi.on("session_shutdown", () => {
				writeFileSync(join(cwd, "shutdown.json"), JSON.stringify({ sigterm: receivedSigterm, calls: faux.state.callCount }));
			});
		}] } });
	return { ...await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel(), tools: toolNames }), services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
try {
	process.exitCode = await runPrintMode(host, { mode: "json", initialMessage: task });
	await pending;
	process.stderr.write(`fixture_summary ${JSON.stringify({ calls: faux.state.callCount, networkCalls, activeTools: host.session.getActiveToolNames() })}\n`);
} finally {
	await host.dispose();
}
