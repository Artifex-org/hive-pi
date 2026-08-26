import { describe, expect, it, afterEach } from "vitest";

import { isHeartbeatOnly, streamIdleMs, turnStallMs } from "./transport.ts";

describe("the stream inactivity budget", () => {
	afterEach(() => {
		delete process.env.CURSOR_STREAM_IDLE_MS;
	});

	// A heartbeat proves the CONNECTION is willing, never that the TURN is
	// progressing. A factory eval case billed 32 cents and then produced not one
	// event for thirty minutes; with no budget there was no error, no output and
	// no end — just an unrelated watchdog eventually killing the task and taking
	// its artifacts with it.
	it("defaults to a budget generous enough for a thinking model", () => {
		expect(streamIdleMs()).toBe(180_000);
	});

	it("is overridable for an operator who hits a real ceiling", () => {
		process.env.CURSOR_STREAM_IDLE_MS = "5000";
		expect(streamIdleMs()).toBe(5_000);
	});

	// A malformed or hostile value must not disable the guard — that would
	// restore the silent-hang behaviour this exists to remove.
	it("ignores a value that would disable it", () => {
		for (const bad of ["", "0", "-1", "abc", "NaN", "Infinity"]) {
			process.env.CURSOR_STREAM_IDLE_MS = bad;
			expect(streamIdleMs()).toBe(180_000);
		}
	});
});

describe("the turn progress budget", () => {
	afterEach(() => {
		delete process.env.CURSOR_TURN_STALL_MS;
	});

	// Why a SECOND budget exists at all. The silence budget is reset by every
	// frame the server sends, heartbeats included, so a stream that stays warm
	// while producing nothing resets it forever. Measured 2026-08-19: a cursor
	// eval case sat 40 minutes past its context pack with the 180s silence
	// budget armed, and it never fired. Silence was never the failure — the
	// connection was fine and the TURN was dead.
	// Longer than the silence budget (a warm connection means the model may still
	// be thinking) but FAR shorter than it was, because the stall it catches is
	// intermittent and retryable — see config.ts for the measured rates. pi
	// retries three times, so this number is multiplied: fifteen minutes made a
	// stalling agent burn forty-five before giving up.
	it("is longer than the silence budget but short enough to retry through", () => {
		expect(turnStallMs()).toBe(240_000);
		expect(turnStallMs()).toBeGreaterThan(streamIdleMs());
		// Three attempts must stay inside a working session, not consume one.
		expect(turnStallMs() * 3).toBeLessThanOrEqual(15 * 60_000);
	});

	it("is overridable", () => {
		process.env.CURSOR_TURN_STALL_MS = "60000";
		expect(turnStallMs()).toBe(60_000);
	});

	// A disabled progress budget restores the silent hang, which is the whole
	// failure being removed here.
	it("ignores a value that would disable it", () => {
		for (const bad of ["", "0", "-1", "abc", "NaN", "Infinity"]) {
			process.env.CURSOR_TURN_STALL_MS = bad;
			expect(turnStallMs()).toBe(240_000);
		}
	});
});

// The predicate the whole fix turns on: if a heartbeat were ever counted as
// work, the progress budget would reset on it and become as useless as the
// silence budget was.
describe("recognising a frame that says nothing", () => {
	it("treats a lone heartbeat as saying nothing", () => {
		expect(isHeartbeatOnly({ execServerMessage: { heartbeat: {} } })).toBe(true);
		expect(isHeartbeatOnly({ interactionUpdate: { heartbeat: {} } })).toBe(true);
	});

	it("treats anything carrying content as progress", () => {
		expect(isHeartbeatOnly({ interactionUpdate: { text: "hi" } })).toBe(false);
		expect(isHeartbeatOnly({ execServerMessage: { mcpArgs: {} } })).toBe(false);
		expect(isHeartbeatOnly({})).toBe(false);
		// A heartbeat arriving ALONGSIDE real content is progress: the content is
		// what matters, and dropping the frame would stall a working turn.
		expect(isHeartbeatOnly({ interactionUpdate: { heartbeat: {}, text: "hi" } })).toBe(false);
	});
});
