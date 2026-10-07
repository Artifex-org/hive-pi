import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import hiveRemote from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllGlobals();
});

// Real SDK + offline provider: ExtensionAPI.sendUserMessage is VOID and catches
// rejected prompts internally. Awaiting it in a fake would hide this bug.
it.each(["success", "failure", "cancel"] as const)("delivers a remote continue after manual compaction %s", async (outcome) => {
	const cwd = await mkdtemp(join(tmpdir(), "hive-remote-compact-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "remote-compact-test", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1000 }] });
	faux.setResponses([
		fauxAssistantMessage("Initial task done. ".repeat(200)),
		fauxAssistantMessage("Ready to continue."),
		...(outcome === "failure" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture compaction failure" })] : []),
		fauxAssistantMessage("Continued successfully."),
	]);
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 100 } });
	const cfg: RemoteConfig = {
		enabled: true, url: "https://hive.test", flushIntervalMs: 1000, eventThreshold: 200,
		allowSteer: true, allowInterrupt: true, allowKill: true, allowSetMode: false,
		allowSetOpMode: false, reportStatus: false, streamDeltas: false,
		streamThinking: false, reportActivity: false, reportWorktree: false, allowAddWorkspace: false,
	};
	let queued = false;
	let claimed = false;
	let attached = false;
	vi.stubGlobal("fetch", async (url: string) => {
		const path = String(url);
		let body: unknown = {};
		if (path.includes("/by-run/")) body = { id: "session-compact" };
		if (path.endsWith("/conversation")) { attached = true; body = { session_id: "session-compact", last_seq: 0 }; }
		if (path.endsWith("/commands/claim")) {
			body = { items: queued && !claimed ? [{ id: "continue-1", kind: "steer", payload: "continue", source: "operator" }] : [] };
			if (queued) claimed = true;
		}
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	let entered = false;
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const extension: ExtensionFactory = (pi) => {
		hiveRemote(pi, { loadConfig: () => cfg, resolveAuth: () => ({ token: "fixture", url: cfg.url, source: "test" }) });
		pi.on("session_start", () => { pi.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-compact" }); });
		pi.on("session_before_compact", async (event) => {
			entered = true;
			await held;
			if (outcome === "cancel") return { cancel: true };
			if (outcome === "failure") return; // run the real summarizer against the failing faux response
			return { compaction: { summary: "Initial task done.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		});
	};
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(), settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), noTools: "all" });
	let ongoingCompact: Promise<unknown> | undefined;
	cleanups.unshift(async () => {
		release();
		await ongoingCompact;
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	const errors: string[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (event) => { errors.push(event.error); } });
	await session.prompt("Finish the initial task.");
	await session.prompt("Confirm the initial result.");
	await vi.waitFor(() => expect(attached).toBe(true));
	const compact = session.compact().catch((error: unknown) => error);
	ongoingCompact = compact;
	await vi.waitFor(() => expect(entered).toBe(true));
	queued = true;
	await vi.waitFor(() => expect(claimed).toBe(true), { timeout: 3500 });
	expect(faux.state.callCount).toBe(2);
	release();
	const result = await compact;
	if (outcome === "success") expect(result).toHaveProperty("summary", "Initial task done.");
	else expect(result).toBeInstanceOf(Error);
	await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("Continued successfully."), { timeout: 3500 });
	expect(faux.state.callCount).toBe(outcome === "failure" ? 4 : 3);
	expect(session.messages.filter((message) => message.role === "user" && (typeof message.content === "string" ? message.content === "continue" : message.content.some((part) => part.type === "text" && part.text === "continue")))).toHaveLength(1);
	expect(errors.filter((error) => error.includes("Cannot submit a prompt while compaction"))).toEqual([]);
}, 12000);
