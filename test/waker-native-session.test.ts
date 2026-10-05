/**
 * The waker against the REAL pi session (offline faux provider): a notice that
 * arrives while the agent is still writing its final turn.
 *
 * The first case is the bug itself, reproduced on the actual runtime: the old
 * direct `sendMessage(…, {followUp, triggerTurn:true})` joins the follow-up
 * queue and pi runs another model call right after "Shall I merge the first?".
 * The waker lets that run END, and still continues once after a plain stop.
 */

import { afterEach, expect, it } from "vitest";
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
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createWaker, type Notice } from "../extensions/hive-common/waker.ts";

const notice: Notice = { customType: "background", content: "✓ background job `bg-1` finished", display: true };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Run one prompt whose first model turn receives `notice` mid-run, through `send`. */
async function runWithMidRunNotice(finalText: string, send: (pi: ExtensionAPI) => () => void) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-waker-native-"));
	const faux = fauxProvider({
		provider: "waker-native-test",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }],
	});
	faux.setResponses([fauxAssistantMessage(finalText), fauxAssistantMessage("Read the notice and carried on.")]);
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const extension: ExtensionFactory = (pi) => {
		const deliver = send(pi);
		let sent = false;
		// While the first assistant message streams: the agent is mid-run.
		pi.on("message_start", (event) => {
			if (sent || (event.message as { role?: string }).role !== "assistant") return;
			sent = true;
			deliver();
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
		model: faux.getModel(),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
	});
	cleanups.push(async () => {
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
	});
	await session.bindExtensions({ mode: "rpc" });
	await session.prompt("Finish the task.");
	const notices = session.messages.filter((message) => message.role === "custom" && message.customType === "background");
	return { calls: faux.state.callCount, notices: notices.length };
}

it("reproduces the bug: a direct triggerTurn notice carries the run past the agent's question", async () => {
	const result = await runWithMidRunNotice("Two options are ready. Shall I merge the first?", (pi) => () =>
		pi.sendMessage(notice, { deliverAs: "followUp", triggerTurn: true }),
	);
	expect(result).toEqual({ calls: 2, notices: 1 });
}, 15_000);

it("lets the run end on the agent's question; the notice is delivered, not acted on", async () => {
	const result = await runWithMidRunNotice("Two options are ready. Shall I merge the first?", (pi) => {
		const waker = createWaker(pi, "test");
		return () => waker.deliver(notice, "completion");
	});
	expect(result).toEqual({ calls: 1, notices: 1 });
}, 15_000);

it("still continues once after a plain stop, so the agent reads the notice", async () => {
	const result = await runWithMidRunNotice("Wave done.", (pi) => {
		const waker = createWaker(pi, "test");
		return () => waker.deliver(notice, "completion");
	});
	expect(result).toEqual({ calls: 2, notices: 1 });
}, 15_000);
