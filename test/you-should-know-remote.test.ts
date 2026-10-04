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
import { createFakePi, type FakePi, type FakeCtxOptions } from "./fake-pi.ts";

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
let serverSupported: boolean | undefined;
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
		if (path === "/me") return json({ id: "owner-1", name: "Fixture owner" });
		if (path.startsWith("/agent-sessions/by-run/")) return json({ id: "sess-1" });
		if (path.endsWith("/conversation")) { conversations.push(body); return json({ session_id: "sess-1", last_seq: 0, ...(serverSupported === undefined ? {} : { can_control_you_should_know: serverSupported }) }); }
		if (path.endsWith("/status")) statuses.push(body);
		if (path.endsWith("/commands/claim")) return json({ items: queued.splice(0) });
		return json({});
	});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });
async function start(overrides: Partial<RemoteConfig> = {}, loaded = true, context: FakeCtxOptions = rpc, attach = true) {
	// Remote loads before scanner in the real package: exercise that order.
	hiveRemote(fake.api, { loadConfig: () => ({ ...loadConfig(), enabled: true, url: BASE, streamDeltas: true, allowSetMode: true,
		reportStatus: true, flushIntervalMs: 1000, reportWorktree: false, reportActivity: false, ...overrides }),
		resolveAuth: () => ({ token: "t", url: BASE, source: "test" }) } as RemoteDeps);
	if (loaded) wireYouShouldKnow(fake.api, { ...DEFAULT_CONFIG, intervalMs: 100, timeoutMs: 500 }, scanner);
	await fake.emit({ type: "session_start", reason: "startup" }, context);
	if (attach) fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-1" });
	await vi.advanceTimersByTimeAsync(6000);
}
async function prose(context: FakeCtxOptions = rpc) {
	await fake.emit({ type: "message_end", message: reply(quote) }, context);
	await fake.emit({ type: "agent_settled" }, context);
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
		serverSupported = undefined;
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
	it.each(["print", "json"] as const)("does not report controls or reading from attached %s", async mode => {
		const context = { mode, hasUI: false };
		await start({}, true, context); await prose(context);
		expect(scanner).not.toHaveBeenCalled(); expect(state()).toBeUndefined();
		expect(conversations.every(c => c.can_control_you_should_know === undefined)).toBe(true);
	});
	it("keeps standalone RPC inert and unreported", async () => {
		await start({}, true, rpc, false); await prose();
		expect(scanner).not.toHaveBeenCalled(); expect(state()).toBeUndefined();
		expect(conversations).toEqual([]);
	});
	it("bootstraps supported RPC from an explicit false capability response", async () => {
		serverSupported = false;
		await start();
		expect(conversations[0].can_control_you_should_know).toBeUndefined();
		expect(conversations.at(-1)?.can_control_you_should_know).toBe(true);
		await prose(); expect(scanner).toHaveBeenCalledTimes(1);
		expect(state()).toMatchObject({ notes: [note] });
	});
	it("acknowledges idle off/on and dismiss/off without another assistant turn", async () => {
		await start();
		for (const action of ["off", "on", "dismiss", "off"]) {
			await command(action);
			expect(state()).toMatchObject({ command_id: `c${nextCommand}`, enabled: action === "on" || action === "dismiss" });
		}
		expect(scanner).not.toHaveBeenCalled(); expect(fake.userMessages).toEqual([]);
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
		expect(last).toBeUndefined();
		expect(fake.busEvents.filter(e => e.name === YSK_STATE_CHANNEL).some(e => (e.payload as { notes?: unknown[] } | undefined)?.notes?.length)).toBe(false);
	});
	it("reattaches without stale capability or overlap while canceled transport settles", async () => {
		let resolve!: (v: AssistantMessage) => void;
		scanner.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
		await start();
		await fake.emit({ type: "message_end", message: reply(quote) }, rpc);
		await fake.emit({ type: "agent_settled" }, rpc); await vi.advanceTimersByTimeAsync(0);
		await fake.runCommand("hive-remote-off", "", rpc);
		expect(scanner.mock.calls[0][2].aborted).toBe(true);
		const reports = conversations.length;
		await fake.runCommand("hive-remote-on", "", rpc);
		await vi.advanceTimersByTimeAsync(6000); await prose();
		expect(conversations.length).toBeGreaterThan(reports);
		expect(conversations[reports].can_control_you_should_know).toBeUndefined();
		expect(state()).toMatchObject({ phase: "waiting", notes: [] });
		expect(scanner).toHaveBeenCalledTimes(1);
		resolve(reply(JSON.stringify({ notes: [{ ...note, text: "Stale verdict" }] })));
		await vi.advanceTimersByTimeAsync(5000); // status backstop after an in-flight report
		expect(scanner).toHaveBeenCalledTimes(2);
		expect(state()).toMatchObject({ phase: "idle", notes: [note] });
		expect(conversations.at(-1)?.can_control_you_should_know).toBe(true);
	});
});
