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
	shutdownDone: undefined as ((done: Promise<void>) => void) | undefined }));
vi.mock("node:fs/promises", async original => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
		const file = await actual.open(...args), pause = fake.setupWrite;
		if (typeof args[0] === "string" && args[0].endsWith("pilot-fixture.txt") && pause) {
			const write = file.writeFile.bind(file);
			file.writeFile = async (...values: Parameters<typeof write>) => { await pause(values[0]); await write(...values); };
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
afterEach(async () => { fake.setupWrite = undefined; fake.shutdownDone = undefined; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
it.each(["pilot", "report-failure", "deadline", "cleanup-failure", "fixture-change", "setup-reload", "unknown-slash", "positional"] as const)("real AgentSession pilot protocol and unarmed startup refusal: %s", async mode => {
	const root = await mkdtemp(join(tmpdir(), "sdk-real-session-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
	for (const [name, value] of Object.entries({ HIVE_CLAUDE_SDK: "1", HIVE_CLAUDE_SDK_PILOT: "1",
		HIVE_CLAUDE_SDK_EXECUTABLE: "/offline/claude", HIVE_CLAUDE_SDK_STATE_DIR: root,
		HIVE_URL: "https://offline.invalid", HIVE_TOKEN: "offline", HIVE_LAUNCH_ID: "offline-pilot" })) vi.stubEnv(name, value);
	let queries = 0; fake.leases = 0; fake.closes = 0; fake.deadlineMs = mode === "deadline" ? 50 : 180_000; let readNonce = "";
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
		extensionFactories: [async pi => { await claudeSdk(pi); pi.events.on("hive.claude-sdk-pilot.result", report => resolve(report as PilotReport)); }] });
	await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
	const model = claudeSdkModels().find(model => model.id.includes("sonnet"))!;
	const sessionManager = SessionManager.inMemory(root);
	const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
		settingsManager: settings, resourceLoader: loader, sessionManager });
	cleanups.push(async () => { await session.abort(); session.dispose(); });
	await session.bindExtensions({ mode: "json" });
	expect(fake.leases).toBe(0);
	if (mode === "unknown-slash" || mode === "positional") {
		await session.prompt(mode === "unknown-slash" ? "/unknown-sdk-pilot" : "unarmed positional input");
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: expect.stringContaining("claude_sdk_pilot_not_armed") });
		expect(queries).toBe(0); expect(fake.leases).toBe(0);
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
	await Promise.all([session.prompt("/claude-sdk-pilot --exclude claude-7"), session.prompt("/claude-sdk-pilot --exclude claude-7")]);
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
	expect(report).toMatchObject({ status: mode === "report-failure" ? "failed" : "passed", category: mode === "report-failure" ? "reporting" : "none",
		report_publication_failures: mode === "report-failure" ? 1 : 0, reserved_sdk_turns: 3, observed_sdk_turns: 3,
		tool_authority: "passed", history_recall: "passed", explicit_resets: 1, query_cleanup: "passed", fixture_cleanup: "passed" });
	expect(queries).toBe(2); expect(fake.closes).toBe(2);
	expect(delivered).toMatchObject([{ isError: false }, { isError: true, content: [{ text: "Claude SDK pilot write denied" }] }]);
	expect(session.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
	expect(await readdir(root)).not.toContain("pilot-fixture.txt");
	expect(sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "claude-sdk-pilot-result")).toBe(true);
	if (mode === "report-failure") return; // event + canonical status survived the failed artifact
	const saved = await readFile(join(root, "pilot-result.json"), "utf8");
	expect(saved).not.toContain(readNonce); expect(saved).not.toContain("offline-a");
	const leases = fake.leases;
	await session.reload();
	await session.prompt("/claude-sdk-pilot --exclude claude-7");
	expect(queries).toBe(2); expect(fake.leases).toBe(leases);
	expect(await readFile(join(root, "pilot-result.json"), "utf8")).toBe(saved);
});
