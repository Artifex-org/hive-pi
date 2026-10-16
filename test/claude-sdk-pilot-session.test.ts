/** Real AgentSession + real builtin filesystem tools; only SDK/lease/CLI are fake. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "./claude-sdk-test-deferred.ts";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFactory } from "../extensions/claude-sdk/provider.ts";
import type { PilotReport } from "../extensions/claude-sdk/pilot.ts";
const fake = vi.hoisted(() => ({ query: undefined as QueryFactory | undefined, leases: 0, closes: 0, deadlineMs: 180_000,
	setupWrite: undefined as ((data: unknown) => Promise<void>) | undefined,
	reportWrite: undefined as (() => Promise<void>) | undefined,
	writeStarted: undefined as ((work: Promise<void>) => void) | undefined,
	latchSync: undefined as (() => Promise<void>) | undefined,
	latchOpen: undefined as (() => Promise<void>) | undefined,
	latchClosed: undefined as (() => void) | undefined,
	runtimeRemove: undefined as (() => Promise<void>) | undefined,
	shutdownDone: undefined as ((done: Promise<void>) => void) | undefined,
	barrierQueued: undefined as (() => void) | undefined, resetStarted: undefined as (() => void) | undefined, resets: 0 }));
vi.mock("node:fs/promises", async original => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
		if (typeof args[0] === "string" && args[0].split("/").at(-1)?.startsWith("query-")) await fake.runtimeRemove?.();
		return actual.rm(...args);
	}, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
		if (typeof args[0] === "string" && args[0].endsWith("pilot-result.json")) await fake.reportWrite?.();
		return actual.writeFile(...args);
	}, open: async (...args: Parameters<typeof actual.open>) => {
		const isLatch = typeof args[0] === "string" && args[0].endsWith(".attempt");
		if (isLatch) await fake.latchOpen?.();
		const file = await actual.open(...args), report = fake.reportWrite, latch = fake.latchSync, closed = fake.latchClosed;
		if (isLatch && closed) { const close = file.close.bind(file); file.close = async () => { await close(); closed(); }; }
		if (typeof args[0] === "string" && args[0].endsWith(".attempt") && latch) {
			const sync = file.sync.bind(file);
			file.sync = async () => { await latch(); await sync(); };
		}
		const pause = typeof args[0] !== "string" ? undefined : args[0].endsWith("pilot-fixture.txt") ? fake.setupWrite :
			args[0].endsWith("pilot-result.json") && report ? () => report() : undefined;
		if (pause) {
			const write = file.writeFile.bind(file);
			file.writeFile = (...values: Parameters<typeof write>) => {
				const work = (async () => { await pause(values[0]); await write(...values); })();
				fake.writeStarted?.(work);
				return work;
			};
		}
		return file;
	} };
});
vi.mock("../extensions/claude-sdk/provider.ts", async original => {
	const actual = await original<typeof import("../extensions/claude-sdk/provider.ts")>();
	return { ...actual, createClaudeSdkRuntime: (config: Parameters<typeof actual.createClaudeSdkRuntime>[0], deps: Parameters<typeof actual.createClaudeSdkRuntime>[1]) =>
		actual.createClaudeSdkRuntime(config, { ...deps, validateExecutable: async () => {},
			lease: async () => { fake.leases++; return { access_token: "offline", credential: "offline-a", slot: "offline-a", expires_at: new Date(Date.now() + 3600_000).toISOString() }; },
			query: request => { if (!fake.query) throw new Error("Unexpected offline query"); return fake.query(request); } }) };
});
vi.mock("../extensions/claude-sdk/pilot.ts", async original => {
	const actual = await original<typeof import("../extensions/claude-sdk/pilot.ts")>();
	return { ...actual, registerPilot: (...args: Parameters<typeof actual.registerPilot>) => {
		args[5] = fake.deadlineMs;
		const api = args[0], send = api.sendUserMessage, reset = args[3];
		// Observe real API calls without replacing their behavior or results.
		args[0] = new Proxy(api, { get(target, key, receiver) {
			if (key !== "sendUserMessage") return Reflect.get(target, key, receiver);
			return (...values: Parameters<typeof send>) => {
				if (typeof values[0] === "string" && !values[0].startsWith("Hive SDK pilot:") && !values[0].startsWith("From the earlier successful read result")) fake.barrierQueued?.();
				return send(...values);
			};
		} });
		args[3] = async () => { fake.resets++; fake.resetStarted?.(); await reset(); };
		const protocol = actual.registerPilot(...args);
		return { ...protocol, done: () => { const done = protocol.done(); fake.shutdownDone?.(done); return done; } };
	} };
});
import claudeSdk from "../extensions/claude-sdk/index.ts";
import { claudeSdkModels } from "../extensions/claude-sdk/provider.ts";
const frame = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null }) as SDKMessage;
function* response(id: string, content: unknown[], stop: string) {
	yield frame({ type: "message_start", message: { id, usage: {} } });
	for (const [index, block] of content.entries()) {
		yield frame({ type: "content_block_start", index, content_block: block });
		yield frame({ type: "content_block_stop", index });
	}
	yield frame({ type: "message_delta", delta: { stop_reason: stop } });
	yield frame({ type: "message_stop" });
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { fake.setupWrite = undefined; fake.reportWrite = undefined; fake.writeStarted = undefined; fake.latchSync = undefined; fake.latchOpen = undefined; fake.latchClosed = undefined; fake.runtimeRemove = undefined; fake.shutdownDone = undefined; fake.barrierQueued = undefined; fake.resetStarted = undefined; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(["pilot", "report-failure", "message-report-failure", "report-cancel", "setup-deadline", "report-deadline", "latch-sync-deadline", "latch-sync-reject", "latch-open-deadline", "runtime-cleanup-deadline", "settlement-first", "settlement-recall", "settlement-reload", "control-intercept", "deadline", "cleanup-failure", "fixture-change", "setup-reload", "unknown-slash", "positional"] as const)("real AgentSession pilot protocol and unarmed startup refusal: %s", async mode => {
	const root = await mkdtemp(join(tmpdir(), "sdk-real-session-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
	for (const [name, value] of Object.entries({ HIVE_CLAUDE_SDK: "1", HIVE_CLAUDE_SDK_PILOT: "1",
		HIVE_CLAUDE_SDK_EXECUTABLE: "/offline/claude", HIVE_CLAUDE_SDK_STATE_DIR: root,
		HIVE_URL: "https://offline.invalid", HIVE_TOKEN: "offline", HIVE_LAUNCH_ID: "offline-pilot" })) vi.stubEnv(name, value);
	let queries = 0; fake.leases = 0; fake.closes = 0; fake.resets = 0; fake.deadlineMs = mode === "deadline" || mode === "setup-deadline" || mode === "latch-sync-deadline" || mode === "latch-open-deadline" ? 50 :
		mode === "report-deadline" ? 1_000 : mode === "runtime-cleanup-deadline" ? 500 : 180_000; let readNonce = "";
	const heldStage = mode === "settlement-first" || mode === "settlement-reload" ? 1 : mode === "settlement-recall" ? 2 : 0;
	const listenerEntered = deferred(), releaseListener = deferred(), controlQueued = deferred(), resetStarted = deferred();
	const intercepted = deferred(), rawSettlement = deferred();
	const reportWriteEntered = deferred(), releaseReport = deferred();
	if (mode === "report-cancel") fake.reportWrite = async () => { reportWriteEntered.resolve(); await releaseReport.promise; };
	let settlements = 0, controls = 0, reportSeen = false;
	fake.barrierQueued = () => { if (++controls === heldStage) controlQueued.resolve(); };
	fake.resetStarted = () => resetStarted.resolve();
	cleanups.push(async () => { releaseListener.resolve(); });
	const delivered: unknown[] = [];
	fake.query = request => {
		const number = ++queries; expect(request.options.maxTurns).toBe(number === 1 ? 2 : 1);
		expect(request.options.env!.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("512");
		expect(request.options.systemPrompt).toBeTruthy();
		const client = new Client({ name: "offline-pilot", version: "1" });
		return { close: () => { fake.closes++; void client.close(); if (mode === "cleanup-failure") throw new Error("OFFLINE_SECRET_CLOSE_ERROR"); },
			[Symbol.asyncIterator]: () => (async function* () {
			if (mode === "deadline") {
				const signal = request.options.abortController!.signal;
				if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return;
			}
			const content = (await request.prompt[Symbol.asyncIterator]().next()).value.message.content;
			const input = typeof content === "string" ? content : content.flatMap((block: { type: string; text?: string }) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
			if (number === 1) {
				expect(request.options.resume).toBeUndefined();
				const bridge = request.options.mcpServers!.pi; if (bridge.type !== "sdk") throw new Error("Missing real MCP bridge");
				const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.instance.connect(b); await client.connect(a);
				const tools = (await client.listTools()).tools.map(tool => tool.name);
				expect(tools).toEqual(expect.arrayContaining(["read", "write", "bash", "edit"]));
				const path = join(root, "pilot-fixture.txt");
				const calls = [{ type: "tool_use", id: "pilot-read", name: "mcp__pi__read", input: { path } },
					{ type: "tool_use", id: "pilot-write", name: "mcp__pi__write", input: { path, content: "SDK_PILOT_WRITE_MUST_BE_BLOCKED" } }];
				yield* response("authority", calls, "tool_use");
				delivered.push(...await Promise.all(calls.map(call => client.callTool({ name: call.name.endsWith("read") ? "read" : "write",
					arguments: call.input, _meta: { "claudecode/toolUseId": call.id } }))));
				readNonce = await readFile(path, "utf8");
				if (mode === "fixture-change") await writeFile(path, "unexpected alteration");
				yield* response("ack", [{ type: "text", text: "ACK" }], "end_turn");
			} else {
				const seed = await readFile(request.options.resume!, "utf8");
				const rows = seed.trim().split("\n").map(line => JSON.parse(line));
				const results = rows.flatMap(row => Array.isArray(row.message.content) ? row.message.content : [])
					.filter(block => block.type === "tool_result");
				expect(results).toHaveLength(2);
				expect(seed).toContain(readNonce); expect(input).not.toContain(readNonce);
				expect(results.some(result => result.is_error === true)).toBe(true);
				// Recall solely from the actual seeded successful read result.
				const read = results.find(result => result.is_error !== true);
				const stored = read.content.map((block: { text?: string }) => block.text ?? "").join("\n");
				yield* response("recall", [{ type: "text", text: stored.trim() }], "end_turn");
			}
			yield { type: "result", subtype: "success", is_error: false, num_turns: number === 1 ? 2 : 1 } as SDKMessage;
		})() };
	};
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let resolve!: (report: PilotReport) => void;
	const reported = new Promise<PilotReport>(r => { resolve = r; });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [pi => {
			if (mode === "control-intercept") pi.on("input", event => {
				if (event.source === "extension" && event.text.startsWith("HIVE_SDK_PILOT_SETTLED:")) {
					intercepted.resolve(); return { action: "handled" };
				}
			});
		}, async pi => {
			await claudeSdk(pi);
			pi.events.on("hive.claude-sdk-pilot.result", report => { reportSeen = true; resolve(report as PilotReport); });
			// Registered after the pilot's listener, through the real runner.
			pi.on("agent_settled", async () => {
				if (++settlements === heldStage) { listenerEntered.resolve(); await releaseListener.promise; }
			});
		}] });
	await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
	const model = claudeSdkModels().find(model => model.id.includes("sonnet"))!;
	const sessionManager = SessionManager.inMemory(root);
	const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
		settingsManager: settings, resourceLoader: loader, sessionManager });
	cleanups.push(async () => { await session.abort(); session.dispose(); });
	const unsubscribe = session.subscribe(event => { if (event.type === "agent_settled") rawSettlement.resolve(); });
	cleanups.push(async () => { unsubscribe(); });
	const extensionErrors: unknown[] = [];
	await session.bindExtensions({ mode: "json", onError: error => { extensionErrors.push(error); } });
	expect(fake.leases).toBe(0);
	if (mode === "unknown-slash" || mode === "positional") {
		await session.prompt(mode === "unknown-slash" ? "/unknown-sdk-pilot" : "unarmed positional input");
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: expect.stringContaining("claude_sdk_pilot_not_armed") });
		expect(queries).toBe(0); expect(fake.leases).toBe(0);
		return;
	}
	if (mode === "latch-open-deadline") {
		const release = deferred(), entered = deferred();
		let closed = 0;
		fake.latchOpen = async () => { entered.resolve(); await release.promise; };
		fake.latchClosed = () => { closed++; };
		const prompt = session.prompt("/claude-sdk-pilot --exclude claude-7");
		const timers: ReturnType<typeof setTimeout>[] = [];
		const bounded = <T,>(task: Promise<T>) => Promise.race([task, new Promise<"stalled">(r => {
			timers.push(setTimeout(() => r("stalled"), 1_000));
		})]);
		try {
			await entered.promise;
			expect(await bounded(prompt.then(() => "returned"))).toBe("returned");
			expect(await bounded(session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" }).then(() => "shutdown"))).toBe("shutdown");
			expect(sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "claude-sdk-pilot-result")).toHaveLength(0);
			release.resolve();
			const outcome = await bounded(reported);
			expect(outcome).toMatchObject({ status: "failed", category: "deadline", reserved_sdk_turns: 0, observed_sdk_turns: 0 });
			expect(closed).toBe(1);
			expect(queries).toBe(0); expect(fake.leases).toBe(0);
			expect(sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "claude-sdk-pilot-result")).toHaveLength(1);
			await session.reload();
			await session.prompt("/claude-sdk-pilot --exclude claude-7");
			expect(queries).toBe(0); expect(fake.leases).toBe(0);
			expect(sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "claude-sdk-pilot-result")).toHaveLength(1);
		} finally { for (const timer of timers) clearTimeout(timer); release.resolve(); await prompt; }
		return;
	}
	if (mode === "latch-sync-deadline" || mode === "latch-sync-reject" || mode === "runtime-cleanup-deadline") {
		const release = deferred(), entered = deferred();
		if (mode === "runtime-cleanup-deadline") fake.runtimeRemove = async () => { entered.resolve(); await release.promise; };
		else fake.latchSync = async () => {
			entered.resolve();
			if (mode === "latch-sync-reject") throw new Error("OFFLINE_SECRET_LATCH_SYNC_ERROR");
			await release.promise;
		};
		const prompt = session.prompt("/claude-sdk-pilot --exclude claude-7");
		let watchdog: ReturnType<typeof setTimeout> | undefined, shutdownWatchdog: ReturnType<typeof setTimeout> | undefined;
		let shutdown: Promise<unknown> | undefined;
		try {
			const outcome = await Promise.race([reported, new Promise<"unreported">(r => {
				watchdog = setTimeout(() => r("unreported"), 2_500);
			})]);
			expect(outcome).not.toBe("unreported");
			expect(outcome).toMatchObject(mode === "runtime-cleanup-deadline" ? {
				status: "failed", query_cleanup: "failed", fixture_cleanup: "passed",
				reserved_sdk_turns: 2, observed_sdk_turns: 2,
			} : {
				status: "failed", category: mode === "latch-sync-deadline" ? "deadline" : "configuration",
				reserved_sdk_turns: 0, observed_sdk_turns: 0, query_cleanup: "passed",
			});
			await entered.promise;
			// Exercise the actual runner/handler while runtime disposal is held;
			// this is not a claim that Core's entire reload can ignore active I/O.
			shutdown = session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			expect(await Promise.race([shutdown.then(() => "shutdown"), new Promise<"stalled">(r => {
				shutdownWatchdog = setTimeout(() => r("stalled"), 1_000);
			})])).toBe("shutdown");
			expect(queries).toBe(mode === "runtime-cleanup-deadline" ? 1 : 0);
			expect(fake.leases).toBe(mode === "runtime-cleanup-deadline" ? 2 : 0);
			expect(sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "claude-sdk-pilot-result")).toHaveLength(1);
			expect(JSON.stringify(outcome)).not.toContain("OFFLINE_SECRET");
		} finally {
			clearTimeout(watchdog); clearTimeout(shutdownWatchdog); release.resolve();
			await prompt; await shutdown; await session.abort();
		}
		return;
	}
	if (mode === "setup-deadline" || mode === "report-deadline") {
		const release = deferred();
		let heldWrite: Promise<void> | undefined;
		fake.writeStarted = work => { heldWrite = work; };
		if (mode === "setup-deadline") fake.setupWrite = async () => { await release.promise; };
		else fake.reportWrite = async () => { await release.promise; };
		let commandError: unknown;
		const prompt = session.prompt("/claude-sdk-pilot --exclude claude-7").catch(error => { commandError = error; });
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const outcome = await Promise.race([reported, new Promise<"unreported">(r => {
				watchdog = setTimeout(() => r("unreported"), 2_500);
			})]);
			expect(outcome).not.toBe("unreported");
			expect(outcome).toMatchObject(mode === "setup-deadline" ? {
				status: "failed", category: "deadline", reserved_sdk_turns: 0, observed_sdk_turns: 0,
				fixture_cleanup: "failed", query_cleanup: "passed",
			} : {
				status: "failed", category: "reporting", report_publication_failures: 1,
				reserved_sdk_turns: 3, observed_sdk_turns: 3, fixture_cleanup: "passed", query_cleanup: "passed",
			});
			// Neither held operation is released until bounded completion and
			// real extension shutdown have both been observed.
			await prompt;
			await session.reload();
			expect(queries).toBe(mode === "setup-deadline" ? 0 : 2);
			expect(fake.leases).toBe(mode === "setup-deadline" ? 0 : 3);
			// Core emits known-command errors and resolves prompt(), rather
			// than rejecting it. Verify that actual error-delivery boundary.
			expect(commandError).toBeUndefined();
			if (mode === "setup-deadline") expect(extensionErrors).toContainEqual({
				extensionPath: "command:claude-sdk-pilot", event: "command",
				error: "Claude SDK pilot configuration refused; attempt consumed",
			});
			const entries = JSON.stringify(sessionManager.getEntries());
			await session.prompt("/claude-sdk-pilot --exclude claude-7");
			expect(queries).toBe(mode === "setup-deadline" ? 0 : 2);
			expect(fake.leases).toBe(mode === "setup-deadline" ? 0 : 3);
			expect(JSON.stringify(sessionManager.getEntries())).toBe(entries);
			expect(heldWrite).toBeDefined();
			release.resolve();
			await Promise.allSettled([heldWrite!]);
			expect(await readdir(root)).not.toContain("pilot-fixture.txt");
			if (mode === "report-deadline") expect(await readdir(root)).not.toContain("pilot-result.json");
		} finally {
			clearTimeout(watchdog); release.resolve();
			await prompt; await session.reload();
		}
		return;
	}
	if (mode === "setup-reload") {
		const entered = deferred(), release = deferred();
		const shutdown = deferred<{ done: Promise<void> }>();
		fake.setupWrite = async data => { readNonce = String(data); entered.resolve(); await release.promise; };
		fake.shutdownDone = done => shutdown.resolve({ done });
		const prompt = session.prompt("/claude-sdk-pilot --exclude claude-7");
		let reload: Promise<void> | undefined;
		try {
			await entered.promise;
			reload = session.reload();
			const owned = await shutdown.promise;
			let settled = false; void owned.done.then(() => { settled = true; });
			await Promise.resolve(); // Observe an already-resolved promise, not elapsed time.
			expect(settled).toBe(false);
			release.resolve();
			await Promise.all([prompt, reload]);
			const report = await reported;
			expect(report).toMatchObject({ status: "failed", category: "protocol", reserved_sdk_turns: 0,
				observed_sdk_turns: 0, query_cleanup: "passed", fixture_cleanup: "passed" });
			expect(queries).toBe(0); expect(fake.leases).toBe(0);
			expect(await readdir(root)).not.toContain("pilot-fixture.txt");
			const saved = await readFile(join(root, "pilot-result.json"), "utf8");
			expect(readNonce).not.toBe(""); expect(saved).not.toContain(readNonce); expect(saved).not.toContain("offline-a");
		} finally { release.resolve(); await Promise.allSettled([prompt, reload]); }
		return;
	}
	if (mode === "report-failure") await mkdir(join(root, "pilot-result.json")); // actual exclusive-write failure
	if (mode === "message-report-failure") vi.spyOn(sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => { throw new Error("OFFLINE_SECRET_PUBLICATION_ERROR"); });
	await Promise.all([session.prompt("/claude-sdk-pilot --exclude claude-7"), session.prompt("/claude-sdk-pilot --exclude claude-7")]);
	if (mode === "control-intercept") {
		await intercepted.promise;
		await session.reload();
		expect(await reported).toMatchObject({ status: "failed", category: "protocol", explicit_resets: 0,
			reserved_sdk_turns: 2, observed_sdk_turns: 2, query_cleanup: "passed", fixture_cleanup: "passed" });
		expect(queries).toBe(1); expect(fake.leases).toBe(2); expect(fake.resets).toBe(0);
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
		return;
	}
	if (heldStage) {
		try {
			await listenerEntered.promise;
			const next = await Promise.race([controlQueued.promise.then(() => "barrier"), reported.then(() => "report"),
				...(heldStage === 1 ? [resetStarted.promise.then(() => "reset")] : [])]);
			expect(next).toBe("barrier");
			expect(fake.resets).toBe(heldStage - 1); expect(queries).toBe(heldStage); expect(reportSeen).toBe(false);
			if (mode === "settlement-reload") await session.reload();
		} finally { releaseListener.resolve(); await reported; }
	}
	if (mode === "settlement-reload") {
		await rawSettlement.promise;
		// A delayed control from the canceled generation and an unmatched late
		// control must both be consumed, not turned into model input.
		await session.sendUserMessage("HIVE_SDK_PILOT_SETTLED:late");
		expect(await reported).toMatchObject({ status: "failed", category: "protocol", explicit_resets: 0,
			reserved_sdk_turns: 2, observed_sdk_turns: 2, query_cleanup: "passed", fixture_cleanup: "passed" });
		expect(queries).toBe(1); expect(fake.leases).toBe(2); expect(fake.resets).toBe(0);
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
		return;
	}
	if (mode === "report-cancel") {
		try {
			await reportWriteEntered.promise;
			await session.prompt("Cancel this bounded pilot during report publication.");
		} finally { releaseReport.resolve(); await reported; }
	}
	const timeout = setTimeout(() => resolve({ status: "failed", category: "deadline" } as PilotReport), 5_000);
	const report = await reported; clearTimeout(timeout);
	if (mode === "deadline" || mode === "cleanup-failure" || mode === "fixture-change") {
		expect(report).toMatchObject({ status: "failed", category: mode === "deadline" ? "deadline" : mode === "cleanup-failure" ? "cleanup" : "protocol",
			history_recall: "not_verified", query_cleanup: mode === "cleanup-failure" ? "failed" : "passed", fixture_cleanup: "passed" });
		expect(queries).toBe(1);
		// Authorization is intentionally uncached across Pi model requests:
		// initial stream + real tool-result continuation, still ONE SDK query.
		expect(fake.leases).toBe(mode === "deadline" ? 1 : 2);
		expect(await readdir(root)).not.toContain("pilot-fixture.txt");
		expect(await readFile(join(root, "pilot-result.json"), "utf8")).not.toContain("OFFLINE_SECRET");
		return;
	}
	const reportingFailure = mode === "report-failure" || mode === "message-report-failure";
	expect(report).toMatchObject({ status: reportingFailure || mode === "report-cancel" ? "failed" : "passed", category: reportingFailure ? "reporting" : mode === "report-cancel" ? "protocol" : "none",
		report_publication_failures: reportingFailure ? 1 : 0, reserved_sdk_turns: 3, observed_sdk_turns: 3,
		tool_authority: "passed", history_recall: "passed", explicit_resets: 1, query_cleanup: "passed", fixture_cleanup: "passed" });
	expect(queries).toBe(2); expect(fake.closes).toBe(2);
	expect(delivered).toMatchObject([{ isError: false }, { isError: true, content: [{ text: "Claude SDK pilot write denied" }] }]);
	expect(session.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
	expect(session.messages.filter(message => message.role === "user")).toHaveLength(2);
	expect(await readdir(root)).not.toContain("pilot-fixture.txt");
	expect(sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "claude-sdk-pilot-result")).toBe(true);
	if (mode === "report-cancel") {
		const message = sessionManager.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "claude-sdk-pilot-result");
		expect(message && "content" in message ? message.content : undefined).toEqual(expect.stringContaining('"status":"failed"'));
	}
	if (mode === "report-failure") return; // event + canonical status survived the failed artifact
	const saved = await readFile(join(root, "pilot-result.json"), "utf8");
	expect(saved).not.toContain(readNonce); expect(saved).not.toContain("offline-a"); expect(saved).not.toContain("OFFLINE_SECRET");
	const leases = fake.leases;
	await session.reload();
	await session.prompt("/claude-sdk-pilot --exclude claude-7");
	expect(queries).toBe(2); expect(fake.leases).toBe(leases);
	expect(await readFile(join(root, "pilot-result.json"), "utf8")).toBe(saved);
});
