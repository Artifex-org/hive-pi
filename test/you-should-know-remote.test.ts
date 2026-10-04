import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import hiveRemote, { type RemoteDeps } from "../extensions/hive-remote/index.ts";
import { loadConfig, type RemoteConfig } from "../extensions/hive-remote/config.ts";
import { DEFAULT_CONFIG, wireYouShouldKnow, type Scanner } from "../extensions/you-should-know/index.ts";
import { HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import { YSK_CONTROL_CHANNEL, YSK_STATE_CHANNEL } from "../extensions/hive-common/you-should-know.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const BASE = "https://hive.test";
const quote = "The migration was not tested against production data.";
const note = { kind: "caveat", text: "Production-data verification is still missing.", quote };
function reply(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", timestamp: 0,
		usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } };
}
let fake: FakePi;
let home: string;
let conversations: Record<string, unknown>[];
let statuses: Record<string, unknown>[];
let queued: { id: string; kind: string; payload: string }[];
let nextCommand: number;
let serverSupported: boolean;
let scanner: ReturnType<typeof vi.fn<Scanner>>;
const rpc = { mode: "rpc" as const, hasUI: false };
beforeEach(() => {
	vi.useFakeTimers(); home = mkdtempSync(join(tmpdir(), "ysk-remote-")); vi.stubEnv("HOME", home);
	fake = createFakePi(); conversations = []; statuses = []; queued = []; nextCommand = 0; serverSupported = true;
	scanner = vi.fn<Scanner>(async () => reply(JSON.stringify({ notes: [note] })));
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		if (path.startsWith("/agent-sessions/by-run/")) return json({ id: "sess-1" });
		if (path.endsWith("/conversation")) { conversations.push(body); return json({ session_id: "sess-1", last_seq: 0, ...(serverSupported ? { can_control_you_should_know: true } : {}) }); }
		if (path.endsWith("/status")) statuses.push(body);
		if (path.endsWith("/commands/claim")) return json({ items: queued.splice(0) });
		return json({});
	});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });
async function start(overrides: Partial<RemoteConfig> = {}, loaded = true) {
	// Remote loads before scanner in the real package: exercise that order.
	hiveRemote(fake.api, { loadConfig: () => ({ ...loadConfig(), enabled: true, url: BASE, streamDeltas: true, allowSetMode: true,
		reportStatus: true, flushIntervalMs: 1000, reportWorktree: false, reportActivity: false, ...overrides }),
		resolveAuth: () => ({ token: "t", url: BASE, source: "test" }) } as RemoteDeps);
	if (loaded) wireYouShouldKnow(fake.api, { ...DEFAULT_CONFIG, intervalMs: 100, timeoutMs: 500 }, scanner);
	await fake.emit({ type: "session_start", reason: "startup" }, rpc);
	fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-1" });
	await vi.advanceTimersByTimeAsync(6000);
}
async function prose() {
	await fake.emit({ type: "message_end", message: reply(quote) }, rpc);
	await fake.emit({ type: "agent_settled" }, rpc);
	await vi.advanceTimersByTimeAsync(1000);
}
async function command(action: string) {
	queued.push({ id: `c${++nextCommand}`, kind: "you_should_know", payload: JSON.stringify({ action }) });
	await vi.advanceTimersByTimeAsync(5000);
}
const state = () => statuses.at(-1)?.you_should_know;

describe("You Should Know, attached RPC conversation to scanner and back", () => {
	it("reports default-on state, capability, extracted evidence and bounded cost", async () => {
		await start();
		expect(conversations.at(-1)?.can_control_you_should_know).toBe(true);
		expect(state()).toMatchObject({ version: 1, enabled: true, phase: "idle", notes: [], scans: 0 });
		const reports = statuses.length;
		await vi.advanceTimersByTimeAsync(20_000);
		expect(statuses).toHaveLength(reports); // unchanged scanner state must preserve idle heartbeat silence
		await prose();
		expect(scanner).toHaveBeenCalledTimes(1);
		expect(state()).toMatchObject({ notes: [note], scans: 1, tokens: 15, cost: 0.01 });
		expect(fake.userMessages).toEqual([]); expect(fake.messages).toEqual([]);
	});
	it("dismisses without toggling consent, switches off/on and restores saved-off state", async () => {
		await start(); await prose(); await command("dismiss");
		expect(state()).toMatchObject({ enabled: true, notes: [] });
		await command("off"); await prose();
		expect(state()).toMatchObject({ enabled: false }); expect(scanner).toHaveBeenCalledTimes(1);
		const saved = fake.entries.at(-1)!;
		await fake.emit({ type: "session_start" }, { ...rpc, branch: [{ type: "custom", ...saved }] });
		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-2" });
		await vi.advanceTimersByTimeAsync(6000);
		expect(state()).toMatchObject({ enabled: false, notes: [] });
		await command("on"); await prose(); expect(scanner).toHaveBeenCalledTimes(2);
		expect(fake.busEvents.filter(e => e.name === YSK_CONTROL_CHANNEL).map(e => e.payload)).toEqual([
			{ action: "dismiss", command_id: "c1" }, { action: "off", command_id: "c2" }, { action: "on", command_id: "c3" },
		]);
		expect(state()).toMatchObject({ command_id: "c3" });
	});
	it.each([{ streamDeltas: false }, { reportStatus: false }, { enabled: false }])("neither scans RPC nor leaks quotes without consent: %j", async consent => {
		await start(consent); await prose();
		expect(scanner).not.toHaveBeenCalled(); expect(state()).toBeUndefined();
		expect(conversations.at(-1)?.can_control_you_should_know).toBeUndefined();
	});
	it("never starts RPC scanning against an older server without scanner support", async () => {
		serverSupported = false;
		await start(); await prose();
		expect(scanner).not.toHaveBeenCalled();
	});
	it("reports no scanner capability or default reading when scanner is absent", async () => {
		await start({}, false);
		expect(state()).toBeUndefined(); expect(conversations.at(-1)?.can_control_you_should_know).toBeUndefined();
	});
	it("reports notes but refuses controls without spending-control consent", async () => {
		await start({ allowSetMode: false }); await prose(); await command("off");
		expect(conversations.at(-1)?.can_control_you_should_know).toBeUndefined();
		expect(state()).toMatchObject({ enabled: true, notes: [note] });
	});
	it("rejects unsupported actions without prompting the main model", async () => {
		await start(); await command("invent"); expect(state()).toMatchObject({ enabled: true });
		expect(fake.userMessages).toEqual([]);
	});
	it("cancels RPC transport on detachment and discards late evidence", async () => {
		let resolve!: (v: AssistantMessage) => void;
		scanner.mockImplementation(() => new Promise(r => { resolve = r; }));
		await start();
		await fake.emit({ type: "message_end", message: reply(quote) }, rpc);
		await fake.emit({ type: "agent_settled" }, rpc); await vi.advanceTimersByTimeAsync(0);
		expect(scanner).toHaveBeenCalledTimes(1);
		await fake.emit({ type: "session_shutdown" }, rpc);
		expect(scanner.mock.calls[0][2].aborted).toBe(true);
		resolve(reply(JSON.stringify({ notes: [note] }))); await vi.advanceTimersByTimeAsync(1000);
		const last = fake.busEvents.filter(e => e.name === YSK_STATE_CHANNEL).at(-1)?.payload;
		expect(last).toMatchObject({ notes: [] });
	});
});
