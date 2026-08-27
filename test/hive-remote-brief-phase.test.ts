/**
 * hive-remote turning a held first turn into a phase the browser can see
 * (HIV-2242).
 *
 * Driven through the extension's entry point rather than against `activity.ts`,
 * because the defect was never in the phase machine — `enterPhase` would have
 * done the right thing all along if anything had called it. The bug was that
 * nothing did: the brief blocks `before_agent_start`, every other phase is
 * entered at `turn_start` or later, and `shouldReport` suppresses `idle`. Three
 * correct components, no signal. So the assertions here are on what reaches the
 * WIRE, which is the only place the absence was observable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HIVE_BRIEF_PROGRESS_CHANNEL, HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import hiveRemote, { type RemoteDeps } from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const URL_BASE = "https://hive.test";
const SESSION_ID = "sess-1";
const RUN_ID = "run-abc";

interface Call {
	path: string;
	body: Record<string, unknown> | undefined;
}

function config(over: Partial<RemoteConfig> = {}): RemoteConfig {
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
		// The one knob under test. Everything else is off to keep the request
		// log to the path these assertions read.
		reportActivity: true,
		reportWorktree: false,
		allowAddWorkspace: false,
		...over,
	};
}

function fakeHive() {
	const calls: Call[] = [];
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ path, body });
		if (path.startsWith("/agent-sessions/by-run/")) return json(200, { id: SESSION_ID });
		if (path.endsWith("/conversation")) return json(200, { session_id: SESSION_ID, last_seq: 0 });
		if (path.endsWith("/commands/claim")) return json(200, { items: [] });
		return json(200, {});
	});

	return {
		beats: () =>
			calls
				.filter((c) => c.path.endsWith("/activity"))
				.map((c) => c.body as { phase?: string; detail?: string }),
	};
}

function deps(cfg: RemoteConfig = config()): RemoteDeps {
	return { loadConfig: () => cfg, resolveAuth: () => ({ token: "t", url: URL_BASE, source: "test" }) };
}

let fake: FakePi;

beforeEach(() => {
	vi.useFakeTimers();
	fake = createFakePi();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function attached(): Promise<ReturnType<typeof fakeHive>> {
	const hive = fakeHive();
	hiveRemote(fake.api, deps());
	fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: RUN_ID });
	await vi.advanceTimersByTimeAsync(400);
	return hive;
}

describe("the briefing phase", () => {
	it("beats immediately when the brief announces it has the turn", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo", "knowledge"] });
		await vi.advanceTimersByTimeAsync(10);

		expect(hive.beats().map((b) => b.phase)).toEqual(["briefing"]);
	});

	// The whole point of the lanes riding along: "Briefing" and "Briefing ·
	// repo, knowledge" answer different questions while the operator watches an
	// elapsed timer climb toward two minutes.
	it("names the lanes in the detail", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo", "knowledge", "ticket"] });
		await vi.advanceTimersByTimeAsync(10);

		expect(hive.beats()[0]?.detail).toBe("Briefing · repo, knowledge, ticket");
	});

	// Progress, not a status. HIV-2242 got a row on screen; it then sat on one
	// unchanging line for the length of the pass, which is why a spawning
	// session still read as dead. The lanes finish at different times, so there
	// is real movement to show.
	it("ticks each lane off as it settles", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo", "knowledge"] });
		await vi.advanceTimersByTimeAsync(10);
		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "lane", lane: "repo", ok: true, done: 1, total: 2 });
		await vi.advanceTimersByTimeAsync(10);

		const details = hive.beats().map((b) => b.detail);
		expect(details[0]).toBe("Briefing · repo, knowledge");
		expect(details[details.length - 1]).toBe("Briefing · repo ✓, knowledge (1/2)");
	});

	// A lane that gave up is the single most useful thing this row can say —
	// "the knowledge brain is down" versus "this is a big repo". Marked, never
	// dropped, or a degraded pass would look merely slow.
	it("marks a failed lane differently from a finished one", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo", "knowledge"] });
		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "lane", lane: "knowledge", ok: false, done: 1, total: 2 });
		await vi.advanceTimersByTimeAsync(10);

		const details = hive.beats().map((b) => b.detail);
		expect(details[details.length - 1]).toBe("Briefing · repo, knowledge ✕ (1/2)");
	});

	// The phase must not restart. A lane beat re-enters `briefing` on purpose,
	// so the pane keeps one elapsed timer running instead of resetting it to
	// zero every time a lane lands.
	it("stays in the briefing phase across lane beats", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo", "knowledge"] });
		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "lane", lane: "repo", ok: true, done: 1, total: 2 });
		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "lane", lane: "knowledge", ok: true, done: 2, total: 2 });
		await vi.advanceTimersByTimeAsync(10);

		expect(new Set(hive.beats().map((b) => b.phase))).toEqual(new Set(["briefing"]));
	});

	// A lane beat with no `start` before it belongs to a pass this handler never
	// saw. It must not drag an unrelated phase into `briefing`.
	it("ignores a lane beat outside a briefing phase", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "lane", lane: "repo", ok: true, done: 1, total: 1 });
		await vi.advanceTimersByTimeAsync(10);

		expect(hive.beats().map((b) => b.phase)).not.toContain("briefing");
	});

	// THE CONTROL, and it is worth stating exactly. Without the announcement the
	// session reports `idle` ONCE — the transition is news — and then nothing at
	// all, because `shouldReport` suppresses idle re-beats by design. So for the
	// whole window the brief holds, the newest thing the server knows about a
	// working agent is the word `idle`, which the pane classifies as at rest and
	// draws no activity row for. Half a minute of that is the bug; a test that
	// cannot see the difference is not testing it.
	it("reports idle once and then nothing, when the brief never announces", async () => {
		const hive = await attached();

		await vi.advanceTimersByTimeAsync(30_000);

		expect(hive.beats().map((b) => b.phase)).toEqual(["idle"]);
	});

	// `working`, not `idle`: the turn is about to start, and `idle` is a phase
	// the beat suppresses — so claiming it would swap a wrong row for no row.
	it("moves to working when the brief releases the turn", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo"] });
		await vi.advanceTimersByTimeAsync(10);
		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "end" });
		await vi.advanceTimersByTimeAsync(10);

		expect(hive.beats().map((b) => b.phase)).toEqual(["briefing", "working"]);
	});

	// An `end` whose `start` this process never saw — an extension switched on
	// mid-brief, a replayed event — must not drag an unrelated phase into
	// `working`. Only the phase this handler set is its to clear.
	it("ignores a release it never claimed", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "end" });
		await vi.advanceTimersByTimeAsync(10);

		expect(hive.beats()).toEqual([]);
	});

	// The heartbeat is also the DELIVERY RETRY path: the brief starts about a
	// second after session_start, and the attach it needs may not have landed
	// yet. A single fire-and-forget beat would then be lost with nothing to
	// correct it, and the workspace would stay blank for the whole 120s.
	it("keeps beating while the brief holds the turn", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo"] });
		await vi.advanceTimersByTimeAsync(45_000);

		const phases = hive.beats().map((b) => b.phase);
		expect(phases.length).toBeGreaterThan(1);
		expect(new Set(phases)).toEqual(new Set(["briefing"]));
	});

	// The detail rides ONCE per phase; the server preserves it across the
	// heartbeats that follow. Re-sending the same string every ten seconds
	// would be pure wire noise.
	it("sends the detail once, not on every heartbeat", async () => {
		const hive = await attached();

		fake.api.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "start", lanes: ["repo"] });
		await vi.advanceTimersByTimeAsync(45_000);

		expect(hive.beats().filter((b) => b.detail !== undefined)).toHaveLength(1);
	});
});
