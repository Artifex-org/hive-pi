/**
 * hive-telemetry's ENTRY POINT, driven through the fake pi.
 *
 * The other half of the gap HIV-1627 names: this file owns the session row every
 * fleet aggregate reads, and nothing exercised it running. Its sibling
 * `spool.test.ts` covers the spool as a pure module; what was untested is the
 * WIRING — that a flush reaches the network at all, that a failed one keeps the
 * only remaining copy of a session's numbers, and that the version it reports is
 * the version it is running.
 *
 * State is redirected with `vi.mock` on the extension's identity module, the
 * same way `spool.test.ts` does it, so no production seam is added and the test
 * cannot touch the developer's real `~/.pi/agent/hive-telemetry/`.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import type { ResolvedConfig } from "../extensions/hive-telemetry/types.ts";

const URL_BASE = "https://hive.test";

let dir: string;
let cfg: ResolvedConfig;

vi.mock("../extensions/hive-telemetry/identity.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../extensions/hive-telemetry/identity.ts")>()),
	spoolDir: () => dir,
	configPath: () => join(dir, "config.json"),
	loadConfig: () => cfg,
	resolveAuth: (c: ResolvedConfig) => (c.enabled ? { token: "t", url: URL_BASE, source: "test" } : null),
}));

const hiveTelemetry = (await import("../extensions/hive-telemetry/index.ts")).default;
const { piVersion } = await import("../extensions/hive-common/piVersion.ts");

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		enabled: true,
		url: URL_BASE,
		flushIntervalMs: 1_000,
		eventThreshold: 1,
		spoolEveryFlush: true,
		...(over as Record<string, unknown>),
	} as ResolvedConfig;
}

interface Posted {
	path: string;
	body: Record<string, unknown>;
}

/**
 * The two endpoints take SEPARATE status queues. They are different calls under
 * different rules — the usage flush stops on a 401, the heartbeat backs off —
 * and a shared queue makes which one got which status depend on timer ordering,
 * so "the heartbeat's own token was refused" is otherwise not expressible.
 */
function fakeHive(statuses: number[] = [], heartbeatStatuses: number[] = []) {
	const posts: Posted[] = [];
	const queues: Record<string, number[]> = {
		"/agent-sessions": [...statuses],
		"/agent-sessions/heartbeat": [...heartbeatStatuses],
	};
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		posts.push({ path, body });
		const status = queues[path]?.shift() ?? 200;
		return new Response(JSON.stringify({ ok: status === 200 }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	});
	return {
		posts,
		// The usage flush ONLY. `/agent-sessions/heartbeat` is a different call on
		// the same prefix and a different rule — an idle session still has to
		// speak, because silence is how the server concludes it is dead — so
		// counting both would make "did the flush retry?" unanswerable.
		sessions: () => posts.filter((p) => p.path === "/agent-sessions"),
		heartbeats: () => posts.filter((p) => p.path === "/agent-sessions/heartbeat"),
	};
}

/** A turn with real usage on it, which is what makes a flush worth sending. */
async function oneTurn(fake: FakePi): Promise<void> {
	await fake.emit({ type: "session_start", reason: "new" });
	await fake.emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			model: "anthropic/claude-opus-4",
			usage: { input: 100, output: 50 },
		},
	});
	await fake.emit({ type: "turn_end" });
}

let fake: FakePi;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hive-telemetry-wiring-"));
	cfg = config();
	vi.useFakeTimers();
	fake = createFakePi();
});

afterEach(() => {
	vi.unstubAllGlobals();
	// There is no vitest config, so `restoreMocks` is off and a `vi.spyOn(Math,
	// "random")` from one test would otherwise still be pinning the jitter for
	// every test after it — the shape in which a test passes only because of the
	// neighbour that ran before it.
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

describe("the reported agent version", () => {
	// The defect this ticket exists for, asserted where it actually reaches the
	// database rather than only at the resolver. `agent_version` was the literal
	// "0.83.0" while hive-pi had been pinned to 0.84.0 since #108, so every
	// session misreported the one column that lets a behaviour change be
	// attributed to a pin bump.
	it("is the resolved version, on the payload that goes on the wire", async () => {
		const hive = fakeHive();
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);

		const sent = hive.sessions();
		expect(sent.length).toBeGreaterThan(0);
		expect(sent[0]?.body.agent_version).toBe(piVersion());
		expect(sent[0]?.body.agent_version).not.toBe("0.83.0");
	});
});

describe("flush", () => {
	it("reaches the network at all", async () => {
		const hive = fakeHive();
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(hive.sessions().length).toBeGreaterThan(0);
		expect(hive.sessions()[0]?.body).toHaveProperty("client_run_id");
	});

	it("uploads a schema-validation tool failure as bad_args", async () => {
		const hive = fakeHive();
		hiveTelemetry(fake.api);

		await fake.emit({ type: "session_start", reason: "new" });
		await fake.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "mcp" });
		await fake.emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "mcp",
			isError: true,
			result: { content: [{ type: "text", text: 'Error: validating "arguments": required: missing properties: ["run_id"]' }] },
		});
		await vi.advanceTimersByTimeAsync(2_000);

		const sent = hive.sessions()[0]?.body.tools as Array<Record<string, unknown>>;
		expect(sent).toEqual([{ tool_name: "mcp", calls: 1, errors: 1, error_kinds: { bad_args: 1 } }]);
	});

	// fake-pi's header names "a spool deleted on failure" as one of the three
	// shipped bugs it was built to catch. This is that bug's home: the spool is
	// the ONLY remaining copy of a session's numbers precisely when the POST
	// failed, so a transient failure must keep it.
	it("keeps the spooled copy when the POST fails", async () => {
		fakeHive([503]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
	});

	it("clears the spool once the POST succeeds", async () => {
		fakeHive([200]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
	});

	// A 401 must not be retried on a timer: hive's authMiddleware writes
	// api_tokens.last_used_at on every call, so a two-minute retry loop against a
	// revoked token looks like credential stuffing. The spooled copy stays,
	// because the token may yet be repaired.
	it("stops retrying after an auth failure but keeps the data", async () => {
		const hive = fakeHive([401]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);
		const afterFirst = hive.sessions().length;
		await vi.advanceTimersByTimeAsync(30_000);

		expect(hive.sessions().length).toBe(afterFirst);
		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
	});
});

/**
 * The heartbeat under a rejected credential (HIV-1639).
 *
 * The rule the flush follows — stop, so a revoked token is not hammered — used
 * to have a hole next to it: the `run.dirty === 0` branch called postHeartbeat
 * directly, with no authFailed check and no backoff. Measured here before the
 * fix: usage posts froze at 3 while heartbeats reached 33 over 30 simulated
 * seconds, one presentation of a revoked credential per interval for the life
 * of the process.
 *
 * The fix is BACKOFF, not silence, and both halves are load-bearing. Silence is
 * how the server concludes a session is dead: a stopped heartbeat means a
 * session whose token is repaired mid-flight may already have been reaped, and
 * a bad-token session vanishes from the fleet view instead of showing up there
 * as unauthenticated — which is the state an operator needs in order to fix it.
 */
describe("the heartbeat when hive refuses the credential", () => {
	/** The auth-rejection notice, which must appear exactly once per transition. */
	const rejections = () => fake.entries.filter((e) => e.customType === "hive-telemetry-auth-rejected");
	const message = (index = 0) => String((rejections()[index]?.data as { message?: unknown } | undefined)?.message ?? "");

	it("backs off rather than stopping, and rather than hammering once per interval", async () => {
		// Pin the ±20% jitter so the schedule is exact: with a 1s interval the
		// backoff (60s, 120s, 240s, 480s …) is what decides the cadence, and the
		// heartbeats land at t≈60s/180s/420s/900s — four in half an hour, against
		// 1800 unbounded.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const hive = fakeHive([401]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);
		const flushesAtLatch = hive.sessions().length;
		const beatsAtLatch = hive.heartbeats().length;

		await vi.advanceTimersByTimeAsync(30 * 60_000);
		const beats = hive.heartbeats().length - beatsAtLatch;

		expect(beats).toBeGreaterThan(0); // not silent: the session stays visible
		expect(beats).toBeLessThanOrEqual(6); // not 1-per-interval: bounded by the curve
		// The existing guard is untouched: the usage flush stays stopped, and the
		// spool keeps the only remaining copy of the numbers.
		expect(hive.sessions().length).toBe(flushesAtLatch);
		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
	});

	// The over-correction the backoff must NOT make. A 5xx says the server is
	// having a bad minute, not that this credential is bad — slowing the
	// heartbeat down would make hive's own fleet view conclude the session died
	// because hive was briefly unwell.
	it("keeps full cadence through a transient 5xx", async () => {
		const hive = fakeHive([503]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(30_000);

		// ~30 ticks at the 1s test interval; the flush is backed off, the
		// heartbeat is not.
		expect(hive.heartbeats().length).toBeGreaterThanOrEqual(25);
		expect(rejections()).toHaveLength(0);
	});

	// A session still doing work under a rejected credential. The flush branch
	// used to `return` on a queueFlush the auth latch had already refused, so a
	// BUSY auth-failed session sent nothing at all — the exact disappearance the
	// backoff exists to prevent, reached from the other side.
	it("still heartbeats while the session keeps working", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const hive = fakeHive([401]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);
		const beatsAtLatch = hive.heartbeats().length;

		// Keep the accumulator dirty for the whole window.
		for (let i = 0; i < 10; i++) {
			await fake.emit({ type: "turn_end" });
			await vi.advanceTimersByTimeAsync(3 * 60_000);
		}

		expect(hive.heartbeats().length).toBeGreaterThan(beatsAtLatch);
	});

	// An idle session never flushes, so the flush path — where the latch lives —
	// never runs. Without the heartbeat reporting its own outcome, a token
	// revoked after registration was re-presented every interval forever.
	it("latches when the heartbeat itself is refused", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const hive = fakeHive([], [401]);
		hiveTelemetry(fake.api);

		await fake.emit({ type: "session_start", reason: "new" });
		await vi.advanceTimersByTimeAsync(2_000);
		const beatsAtLatch = hive.heartbeats().length;

		expect(beatsAtLatch).toBeGreaterThan(0);
		expect(rejections()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(hive.heartbeats().length).toBe(beatsAtLatch);
	});

	// BOTH endpoints keep refusing, which is the only shape in which the
	// once-ness claim has anything to prove: with the heartbeat answering 200
	// the flush latch is the sole caller of latchAuthFailure and "exactly once"
	// is true by construction. Here the flush latches first and every backed-off
	// heartbeat then arrives at the same latch on its own 401 — so this fails the
	// moment either caller announces without checking the transition.
	it("says it once, however long the session runs and whichever call is refused", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const hive = fakeHive([401], Array<number>(50).fill(401));
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(30 * 60_000);

		// The second announcer has to have actually run: a heartbeat that never
		// went out could not have re-announced either.
		expect(hive.heartbeats().length).toBeGreaterThan(0);
		expect(rejections()).toHaveLength(1);
	});

	// 401 and 403 arrive as one `authFailed` flag (hive-common's classify is
	// shared with hive-remote), but they need opposite actions from the human:
	// /hive-login replaces a token hive does not recognise, and does nothing at
	// all for one it recognises and refuses.
	it("distinguishes a rotated token from a refused one", async () => {
		fakeHive([401]);
		hiveTelemetry(fake.api);
		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(message()).toContain("401");
		expect(message()).toContain("/hive-login");
		expect(message()).not.toContain("will not help");
	});

	it("says a 403 is not a /hive-login problem", async () => {
		fakeHive([403]);
		hiveTelemetry(fake.api);
		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(message()).toContain("403");
		expect(message()).toContain("will not help");
	});

	// Re-arming. `/hive-login` is not driven here because its handler calls
	// identity's writeConfig/saveCredentials, which resolve their own paths
	// internally and would write into the developer's real ~/.pi. The manual
	// flush is the same latch-clearing code path (snapshotAndPost's 2xx branch),
	// which is what /hive-login's own re-arm relies on.
	it("resumes normal cadence once the credential is accepted again", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const hive = fakeHive([401]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(2_000);
		const beatsWhileRejected = hive.heartbeats().length;

		await vi.advanceTimersByTimeAsync(5_000);
		expect(hive.heartbeats().length).toBe(beatsWhileRejected); // still backed off

		await fake.runCommand("hive-telemetry", "flush");
		await vi.advanceTimersByTimeAsync(10_000);

		expect(hive.heartbeats().length).toBeGreaterThanOrEqual(beatsWhileRejected + 8);
	});
});

describe("the disabled path", () => {
	it("makes no requests and writes no spool when disabled", async () => {
		cfg = config({ enabled: false });
		const hive = fakeHive();
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(hive.posts).toHaveLength(0);
		expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
	});
});

/**
 * A BUSY session must still say it is alive (HIV-1996).
 *
 * The tick used to skip the heartbeat whenever it had QUEUED a usage flush:
 *
 *     if (run.dirty > 0 && queueFlush("interval")) return;
 *
 * `dirty > 0` is true on every tick of a working session, so a busy run took
 * that branch from its first tick and never once reached the heartbeat.
 * Measured on session a78c92ef (2026-08-17): `last_seen_at` NULL for a whole
 * 22-turn run. Liveness rested entirely on the flush — and when the flush loop
 * stopped, the server's 5-minute sweep ended the session `heartbeat_timeout`
 * while the agent kept working, recording 22 turns and $1.57 against the pane's
 * 59 and $6.11, hidden from every `only_live` view.
 *
 * "Reporting usage IS contact" is right, and stays. What changed is that it now
 * requires the flush to have ARRIVED.
 */
describe("liveness on a busy session", () => {
	it("heartbeats even while usage is flowing", async () => {
		const hive = fakeHive();
		hiveTelemetry(fake.api);

		// A session that keeps working: every turn re-dirties the accumulator, so
		// every tick has a flush to queue. This is the shape that went silent.
		for (let i = 0; i < 5; i++) {
			await oneTurn(fake);
			await vi.advanceTimersByTimeAsync(2_000);
		}

		expect(hive.sessions().length).toBeGreaterThan(0); // usage still flows
		// The assertion the bug would fail at zero.
		expect(hive.heartbeats().length).toBeGreaterThan(0);
	});

	it("still speaks when the flush stalls — the case that got a live agent reaped", async () => {
		// 503 on every usage post: the flush is queued, backs off and never
		// arrives, exactly as a stalled flush loop looks from here. Before the
		// fix a queued-but-never-landed flush suppressed the heartbeat forever.
		const hive = fakeHive([503, 503, 503, 503, 503, 503, 503, 503, 503, 503]);
		hiveTelemetry(fake.api);

		await oneTurn(fake);
		await vi.advanceTimersByTimeAsync(20_000);

		expect(hive.heartbeats().length).toBeGreaterThan(0);
	});
});
