import { describe, expect, it } from "vitest";

import { SpeedTracker, deriveTurnSpeed, speedCell } from "./speed.ts";

// The derivation mirrors hive-telemetry #70's timedTurnContribution, plus a
// per-turn division telemetry never does (it divides summed totals). These pin
// the honest-measurement predicate and the one case telemetry can't hit.
describe("deriveTurnSpeed", () => {
	it("times a streamed, normally-stopped turn: tok/s from decode, TTFT from headers", () => {
		// headers@1000, first token@1480, end@2480 → 1000ms decode of 62 tokens,
		// 480ms to first token.
		const speed = deriveTurnSpeed({ headersAt: 1000, firstTokenAt: 1480, endAt: 2480 }, 62, "stop");
		expect(speed).not.toBeNull();
		expect(speed?.tokPerSec).toBeCloseTo(62, 5);
		expect(speed?.ttftMs).toBe(480);
	});

	it("counts a toolUse stop as a complete decode", () => {
		expect(deriveTurnSpeed({ headersAt: 0, firstTokenAt: 200, endAt: 1200 }, 50, "toolUse")).not.toBeNull();
	});

	it("returns null for a non-streaming turn (no first token)", () => {
		expect(deriveTurnSpeed({ headersAt: 1000, firstTokenAt: null, endAt: 2000 }, 40, "stop")).toBeNull();
	});

	it("returns null when nothing was decoded (output <= 0)", () => {
		expect(deriveTurnSpeed({ headersAt: 1000, firstTokenAt: 1100, endAt: 2000 }, 0, "stop")).toBeNull();
	});

	it("returns null for an abnormal stop (aborted/error)", () => {
		expect(deriveTurnSpeed({ headersAt: 1000, firstTokenAt: 1100, endAt: 2000 }, 40, "aborted")).toBeNull();
		expect(deriveTurnSpeed({ headersAt: 1000, firstTokenAt: 1100, endAt: 2000 }, 40, "error")).toBeNull();
	});

	it("returns null rather than Infinity when the whole decode lands in one tick", () => {
		expect(deriveTurnSpeed({ headersAt: 1000, firstTokenAt: 1100, endAt: 1100 }, 5, "stop")).toBeNull();
	});

	it("returns null on a clock skew that inverts an interval", () => {
		expect(deriveTurnSpeed({ headersAt: 1000, firstTokenAt: 900, endAt: 2000 }, 40, "stop")).toBeNull();
	});
});

describe("speedCell", () => {
	it("omits entirely before any timed turn", () => {
		expect(speedCell(null, null)).toBe("");
	});

	it("shows both throughput and avg TTFT after a timed turn", () => {
		expect(speedCell(62, 480)).toBe("62 tok/s · ttft 480 ms");
	});

	it("dashes the throughput (never 0) when the last turn did not stream, keeping the avg", () => {
		expect(speedCell(null, 480)).toBe("— tok/s · ttft 480 ms");
	});

	it("rounds to whole numbers", () => {
		expect(speedCell(61.7, 479.4)).toBe("62 tok/s · ttft 479 ms");
	});
});

describe("SpeedTracker", () => {
	it("stamps first-token only on the FIRST update and folds one timed turn", () => {
		const t = new SpeedTracker();
		t.start(1000);
		t.update(1480); // first token
		t.update(1500); // must NOT move firstTokenAt
		t.update(1600); // must NOT move firstTokenAt
		t.end(62, "stop", 2480);
		// If a later update had won, decode would start at 1600 (880ms → ~70 tok/s)
		// and TTFT would be 600ms; the 480/62 values prove the first update stamped.
		expect(t.lastTokPerSec).toBeCloseTo(62, 5);
		expect(t.avgTtftMs).toBe(480);
		expect(t.cell()).toBe("62 tok/s · ttft 480 ms");
	});

	it("dashes last-turn tok/s but keeps the avg TTFT after a streamed→non-streamed sequence", () => {
		const t = new SpeedTracker();
		t.start(0);
		t.update(200);
		t.end(100, "stop", 1200); // timed: 1000ms/100tok = 100 tok/s, ttft 200ms
		expect(t.lastTokPerSec).toBe(100);
		expect(t.avgTtftMs).toBe(200);

		// A non-streaming turn: start then end, no update between.
		t.start(2000);
		t.end(40, "stop", 3000);
		expect(t.lastTokPerSec).toBeNull(); // last turn didn't stream → dash
		expect(t.avgTtftMs).toBe(200); // average untouched by the untimed turn
		expect(t.cell()).toBe("— tok/s · ttft 200 ms");
	});

	it("averages TTFT across timed turns and reports the newest throughput", () => {
		const t = new SpeedTracker();
		t.start(0);
		t.update(100); // ttft 100
		t.end(50, "stop", 1050); // 1000ms/50 = 50 tok/s
		t.start(2000);
		t.update(2300); // ttft 300
		t.end(120, "stop", 3000); // 700ms/120 ≈ 171.4 tok/s
		expect(t.avgTtftMs).toBe(200); // (100 + 300) / 2
		expect(t.lastTokPerSec).toBeCloseTo(120 / 0.7, 5);
	});

	it("re-arms on start so an aborted stream leaves no stale timing", () => {
		const t = new SpeedTracker();
		t.start(0);
		t.update(100);
		// stream aborted: a new message starts before the previous end
		t.start(5000);
		t.update(5200);
		t.end(80, "stop", 6000);
		expect(t.avgTtftMs).toBe(200); // 5200 − 5000, not 100 − 0
	});

	it("reset() clears the session average", () => {
		const t = new SpeedTracker();
		t.start(0);
		t.update(100);
		t.end(50, "stop", 1050);
		expect(t.avgTtftMs).not.toBeNull();
		t.reset();
		expect(t.avgTtftMs).toBeNull();
		expect(t.lastTokPerSec).toBeNull();
		expect(t.cell()).toBe("");
	});
});
