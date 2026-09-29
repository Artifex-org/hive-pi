/**
 * The Hive workspace's Fast mode toggle, through the REAL bus, in one process.
 *
 * `fast` and `hive-remote` meet only over two channel names. Each could pass
 * its own tests while never hearing the other, so this loads both, drives a
 * `set_fast` command the way the server queues it, and asserts what reaches
 * the wire: the capability, the reported state, and that a browser toggle is
 * session-scoped (no config file written).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fast from "../extensions/fast/index.ts";
import hiveRemote, { type RemoteDeps } from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";
import { FAST_CONTROL_CHANNEL, FAST_STATE_CHANNEL, HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const URL_BASE = "https://hive.test";
const SESSION_ID = "sess-1";
/** The built-in providers the extension captures and delegates to. */
const registry = {
	getProvider: (id: string) => ({ id, streamSimple: () => ({}) as never }),
};
const terra = { provider: "openai-codex", id: "gpt-5.6-terra", api: "openai-codex-responses", contextWindow: 400_000 };

function config(allowSetMode = true): RemoteConfig {
	return {
		enabled: true,
		url: URL_BASE,
		flushIntervalMs: 1_000,
		eventThreshold: 200,
		allowSteer: true,
		allowInterrupt: true,
		allowKill: true,
		allowSetMode,
		allowSetOpMode: true,
		reportStatus: true,
		streamDeltas: false,
		streamThinking: false,
		reportActivity: false,
		reportWorktree: false,
		allowAddWorkspace: false,
	};
}

let fake: FakePi;
let home: string;
let realHome: string | undefined;
let conversations: Array<Record<string, unknown>>;
let statuses: Array<Record<string, unknown>>;
let queued: Array<{ id: string; kind: string; payload: string }>;

beforeEach(() => {
	vi.useFakeTimers();
	home = mkdtempSync(join(tmpdir(), "fast-remote-"));
	realHome = process.env.HOME;
	process.env.HOME = home;
	delete process.env.HIVE_PI_FAST;
	fake = createFakePi();
	conversations = [];
	statuses = [];
	queued = [];
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		if (path.startsWith("/agent-sessions/by-run/")) return json({ id: SESSION_ID });
		if (path.endsWith("/conversation")) {
			conversations.push(body);
			return json({ session_id: SESSION_ID, last_seq: 0 });
		}
		if (path.endsWith("/status")) statuses.push(body);
		if (path.endsWith("/commands/claim")) return json({ items: queued.splice(0) });
		return json({});
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

async function start(opts: { withFast?: boolean; allowSetMode?: boolean } = {}) {
	if (opts.withFast !== false) fast(fake.api);
	hiveRemote(fake.api, {
		loadConfig: () => config(opts.allowSetMode ?? true),
		resolveAuth: () => ({ token: "t", url: URL_BASE, source: "test" }),
	} as RemoteDeps);
	await fake.emit({ type: "session_start", reason: "startup" }, { model: terra as never, modelRegistry: registry });
	fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-1" });
	// Past the 5 s status tick: fast announces at session_start, before the
	// session has attached, so its first reading rides the first tick.
	await vi.advanceTimersByTimeAsync(6_000);
}

async function command(kind: string, payload: string) {
	queued.push({ id: `c${queued.length + 1}`, kind, payload });
	await vi.advanceTimersByTimeAsync(5_000);
}

const controls = () => fake.busEvents.filter((e) => e.name === FAST_CONTROL_CHANNEL).map((e) => e.payload);
const lastStatus = () => statuses.at(-1) ?? {};

describe("Fast mode, workspace to session and back", () => {
	it("declares the capability and reports the state once fast has announced", async () => {
		await start();
		expect(fake.busEvents.some((e) => e.name === FAST_STATE_CHANNEL)).toBe(true);
		expect(conversations.at(-1)?.can_set_fast).toBe(true);
		expect(lastStatus()).toMatchObject({ fast: false, fast_applies: false });
	});

	it("says nothing about fast when the extension is not loaded", async () => {
		await start({ withFast: false });
		expect(conversations.at(-1)?.can_set_fast).toBeUndefined();
		expect(lastStatus()).not.toHaveProperty("fast");
		expect(lastStatus()).not.toHaveProperty("fast_applies");
	});

	it("applies a set_fast for this session only, and reports the result", async () => {
		await start();
		await command("set_fast", JSON.stringify({ enabled: true }));

		expect(controls()).toEqual([{ enabled: true }]);
		expect(lastStatus()).toMatchObject({ fast: true, fast_applies: true });
		expect(fake.statuses.at(-1)).toEqual({ key: "fast", text: "⚡ fast" });
		// A browser toggle must not become the machine's default.
		expect(existsSync(join(home, ".pi", "agent", "hive-telemetry", "fast.config.json"))).toBe(false);

		await command("set_fast", JSON.stringify({ enabled: false }));
		expect(lastStatus()).toMatchObject({ fast: false, fast_applies: false });
	});

	it("ignores a payload that is not a boolean", async () => {
		await start();
		await command("set_fast", JSON.stringify({ enabled: "yes" }));
		await command("set_fast", "not json");
		expect(controls()).toEqual([]);
		expect(lastStatus()).toMatchObject({ fast: false });
	});

	it("is refused, and not offered, without model-switch consent", async () => {
		await start({ allowSetMode: false });
		expect(conversations.at(-1)?.can_set_fast).toBeUndefined();
		await command("set_fast", JSON.stringify({ enabled: true }));
		expect(controls()).toEqual([]);
	});
});
