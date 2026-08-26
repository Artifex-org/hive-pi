import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	abortAllSuspendedTurns,
	claimSuspendedTurn,
	discardSuspendedTurn,
	suspendedTurnCount,
	suspendTurn,
	type SuspendedTurn,
} from "./session.ts";

function fakeTurn(callId: string, modelId = "composer-2.5") {
	const aborts: string[] = [];
	const resumes: string[] = [];
	const turn: SuspendedTurn = {
		callId,
		modelId,
		resume: async (_events, result) => {
			resumes.push(result.text);
		},
		abort: (reason) => {
			aborts.push(reason);
		},
	};
	return { turn, aborts, resumes };
}

describe("parking a Cursor turn while pi runs a tool", () => {
	beforeEach(() => {
		delete process.env.CURSOR_SUSPEND_TTL_MS;
		abortAllSuspendedTurns("test setup");
	});
	afterEach(() => {
		abortAllSuspendedTurns("test teardown");
		vi.useRealTimers();
	});

	it("hands the turn back for the id it was parked under", () => {
		const { turn } = fakeTurn("call-1");
		suspendTurn(turn);
		expect(claimSuspendedTurn("call-1", "composer-2.5")).toBe(turn);
	});

	// A turn resumes exactly once. Leaving it parked after handing it out is how
	// one socket ends up with two writers feeding it different tool results.
	it("consumes the turn on claim", () => {
		const { turn } = fakeTurn("call-1");
		suspendTurn(turn);
		claimSuspendedTurn("call-1", "composer-2.5");
		expect(claimSuspendedTurn("call-1", "composer-2.5")).toBeNull();
		expect(suspendedTurnCount()).toBe(0);
	});

	it("returns null for an id nobody parked", () => {
		expect(claimSuspendedTurn("nope", "composer-2.5")).toBeNull();
	});

	// pi may switch models mid-conversation. The parked turn belongs to the old
	// one and cannot carry the new one's context, so it is dropped rather than
	// resumed under a model that never asked for it.
	it("refuses to resume under a different model, and lets the old turn go", () => {
		const { turn, aborts } = fakeTurn("call-1", "composer-2.5");
		suspendTurn(turn);
		expect(claimSuspendedTurn("call-1", "cursor-grok-4.6-high")).toBeNull();
		expect(aborts).toHaveLength(1);
		expect(suspendedTurnCount()).toBe(0);
	});

	it("aborts a turn superseded by a new one with the same id", () => {
		const first = fakeTurn("call-1");
		const second = fakeTurn("call-1");
		suspendTurn(first.turn);
		suspendTurn(second.turn);
		expect(first.aborts).toHaveLength(1);
		expect(claimSuspendedTurn("call-1", "composer-2.5")).toBe(second.turn);
	});

	// The stream can die while parked. Forgetting the id is what lets the next
	// provider call start a FRESH turn instead of resuming a dead socket.
	it("discards a turn whose stream has gone", () => {
		const { turn, aborts } = fakeTurn("call-1");
		suspendTurn(turn);
		discardSuspendedTurn("call-1", "socket closed");
		expect(aborts).toEqual(["socket closed"]);
		expect(claimSuspendedTurn("call-1", "composer-2.5")).toBeNull();
	});

	// A parked turn holds a real socket with a live heartbeat on it, so the cost
	// of pi never coming back is a leak that lasts as long as the process.
	it("expires a turn nobody came back for", () => {
		vi.useFakeTimers();
		process.env.CURSOR_SUSPEND_TTL_MS = "1000";
		const { turn, aborts } = fakeTurn("call-1");
		suspendTurn(turn);
		vi.advanceTimersByTime(999);
		expect(aborts).toHaveLength(0);
		vi.advanceTimersByTime(2);
		expect(aborts).toHaveLength(1);
		expect(aborts[0]).toMatch(/no tool result/);
		expect(claimSuspendedTurn("call-1", "composer-2.5")).toBeNull();
	});

	it("stops the clock once a turn is claimed", () => {
		vi.useFakeTimers();
		process.env.CURSOR_SUSPEND_TTL_MS = "1000";
		const { turn, aborts } = fakeTurn("call-1");
		suspendTurn(turn);
		claimSuspendedTurn("call-1", "composer-2.5");
		vi.advanceTimersByTime(5000);
		// The turn is live again; expiring it here would tear down a stream that
		// is mid-answer.
		expect(aborts).toHaveLength(0);
	});

	it("keeps turns for different calls apart", () => {
		const a = fakeTurn("call-a");
		const b = fakeTurn("call-b");
		suspendTurn(a.turn);
		suspendTurn(b.turn);
		expect(suspendedTurnCount()).toBe(2);
		expect(claimSuspendedTurn("call-b", "composer-2.5")).toBe(b.turn);
		expect(suspendedTurnCount()).toBe(1);
		expect(a.aborts).toHaveLength(0);
	});

	it("aborts everything still parked when the conversation is abandoned", () => {
		const a = fakeTurn("call-a");
		const b = fakeTurn("call-b");
		suspendTurn(a.turn);
		suspendTurn(b.turn);
		abortAllSuspendedTurns("session ended");
		expect(a.aborts).toEqual(["session ended"]);
		expect(b.aborts).toEqual(["session ended"]);
		expect(suspendedTurnCount()).toBe(0);
	});
});
