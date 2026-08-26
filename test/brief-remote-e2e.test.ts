/**
 * brief → hive-remote, through the REAL bus, in ONE process (HIV-2242).
 *
 * The two suites either side of this one each stub the half they are not
 * testing: `brief-progress` asserts what the brief emits, `hive-remote-brief-
 * phase` emits the event by hand and asserts what reaches the wire. Both would
 * still pass if the two extensions never met — a renamed channel, an import
 * that resolved to a second copy of the constant, a subscription registered
 * behind a flag the other half does not set. That is exactly the class of
 * defect this feature is a fix FOR: three correct components and no signal.
 *
 * So: load both entry points into one fake pi, drive the real
 * `before_agent_start`, and assert the beat that leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runBriefer = vi.hoisted(() => vi.fn());
vi.mock("../extensions/brief/run.ts", () => ({ runBriefer, BRIEFER_ROLE: "briefer" }));

import brief from "../extensions/brief/index.ts";
import hiveRemote, { type RemoteDeps } from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";
import { HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const URL_BASE = "https://hive.test";
const SESSION_ID = "sess-1";
const RUN_ID = "run-abc";
const TASK = "fix HIV-1234 so the placement fold is testable in isolation";

function config(): RemoteConfig {
	return {
		enabled: true,
		url: URL_BASE,
		flushIntervalMs: 1_000,
		eventThreshold: 200,
		allowSteer: true,
		allowInterrupt: true,
		allowKill: true,
		allowSetMode: true,
		allowSetOpMode: true,
		reportStatus: false,
		streamDeltas: false,
		streamThinking: false,
		reportActivity: true,
		reportWorktree: false,
		allowAddWorkspace: false,
	};
}

let fake: FakePi;
let beats: Array<{ phase?: string; detail?: string }>;

beforeEach(() => {
	vi.useFakeTimers();
	fake = createFakePi();
	beats = [];
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		if (path.endsWith("/activity")) beats.push(body);
		if (path.startsWith("/agent-sessions/by-run/")) return json({ id: SESSION_ID });
		if (path.endsWith("/conversation")) return json({ session_id: SESSION_ID, last_seq: 0 });
		if (path.endsWith("/commands/claim")) return json({ items: [] });
		return json({});
	});
	runBriefer.mockResolvedValue({
		draft: null,
		failure: "nothing found",
		model: "cheap/model",
		modelSource: "mode:low",
		usage: null,
		elapsedMs: 90_000,
		timedOut: false,
		lanes: [],
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the two halves, in one process", () => {
	it("turns a held first turn into a beat on the wire", async () => {
		brief(fake.api);
		hiveRemote(fake.api, { loadConfig: config, resolveAuth: () => ({ token: "t", url: URL_BASE, source: "test" }) } as RemoteDeps);
		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: RUN_ID });
		await vi.advanceTimersByTimeAsync(400);
		beats.length = 0;

		await fake.emit({ type: "before_agent_start", prompt: TASK });
		await vi.advanceTimersByTimeAsync(50);

		// The brief announced, hive-remote heard it, and a phase the browser can
		// render left the process — with the lanes the task actually planned.
		expect(beats.map((b) => b.phase)).toEqual(["briefing", "working"]);
		expect(beats[0]?.detail).toBe("Briefing · repo, knowledge, ticket");
	});
});
