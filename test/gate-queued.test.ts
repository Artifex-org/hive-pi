/**
 * A queue wait is not a hang, and the card has to be able to say so.
 *
 * Measured 2026-08-17: an agent dispatched `hive check`, the run sat QUEUED for
 * 27½ minutes behind a busy fleet (created 21:55:39, started 22:23:09), and for
 * that entire time its card read `waiting on Running quality_gate` while its
 * pane sat frozen. Nothing distinguished it from a hung tool.
 *
 * `isQueued` and the `QUEUED — …` line already existed and are correct. What
 * was missing is the number beside them — a static label reads the same at ten
 * seconds and at twenty-seven minutes — and a ceiling suited to a wait with no
 * progress in it.
 */

import { describe, expect, it } from "vitest";

import { fold, humanSecs, isQueued, renderReport, deckSummary } from "../extensions/gate/hivecheck.ts";

const REF = { id: "8ee772a4-90e2-4b5b-9995-66569a3b6b29", number: 3509 };
const CREATED = "2026-08-17T21:55:39.000Z";
const createdMs = Date.parse(CREATED);

/** A run admitted but with nothing on a node — the measured shape. */
function queuedProgress(waitedSecs: number) {
	return fold({
		run: { state: "running", number: 3509, created_at: CREATED, started_at: null },
		tasks: [
			{ key: "lint", state: "ready" },
			{ key: "test", state: "ready" },
			{ key: "web-check", state: "ready" },
		],
		substeps: [],
		steps: ["lint"],
		ref: REF,
		nowMs: createdMs + waitedSecs * 1000,
	});
}

describe("a queued run", () => {
	it("is recognised as queued, not as work in progress", () => {
        // Hive marks a run `running` the moment it is ADMITTED, so the run's own
        // word cannot answer this — nothing done and nothing on a node can.
		expect(queuedProgress(60).run_state).toBe("running");
		expect(isQueued(queuedProgress(60))).toBe(true);
	});

	it("carries how long it has been waiting", () => {
		expect(queuedProgress(42).queued_secs).toBe(42);
		expect(queuedProgress(27 * 60).queued_secs).toBe(1620);
	});

	it("measures the wait from the run's CREATION, not from when we attached", () => {
		// `hive check` packs and uploads a snapshot before the follow starts, so
		// the two clocks differ by however long that took. Hive's own queue-wait
		// stats use the run's clock, and disagreeing with them would make the
		// card and `get_queue_wait` describe the same wait differently.
		const p = fold({
			run: { state: "running", created_at: CREATED, started_at: null },
			tasks: [{ key: "lint", state: "ready" }],
			substeps: [],
			steps: ["lint"],
			ref: REF,
			nowMs: createdMs + 5 * 60_000,
		});
		expect(p.queued_secs).toBe(300);
	});

	it("says the wait in the report line and in the deck verdict", () => {
		const p = queuedProgress(27 * 60);
		expect(renderReport(p)).toContain("QUEUED for 27m");
		expect(renderReport(p)).toContain("waiting for a fleet slot");
		expect(deckSummary(p)).toContain("queued 27m");
	});

	it("omits the number rather than inventing one when the clock is unknown", () => {
		// An older server that does not return `created_at`. Better a label with
		// no number than a number measured from the wrong instant.
		const p = fold({
			run: { state: "running", started_at: null },
			tasks: [{ key: "lint", state: "ready" }],
			substeps: [],
			steps: ["lint"],
			ref: REF,
			nowMs: Date.now(),
		});
		expect(p.queued_secs).toBeUndefined();
		expect(renderReport(p)).toContain("QUEUED —");
	});

	it("stops calling it queued once a step is actually running", () => {
		const p = fold({
			run: { state: "running", created_at: CREATED, started_at: "2026-08-17T22:23:09.000Z" },
			tasks: [{ key: "lint", state: "running" }],
			substeps: [],
			steps: ["lint"],
			ref: REF,
			nowMs: createdMs + 30 * 60_000,
		});
		expect(isQueued(p)).toBe(false);
		expect(renderReport(p)).toContain("STILL RUNNING");
	});
});

describe("humanSecs", () => {
	it("reads the way a person says a wait", () => {
		expect(humanSecs(0)).toBe("0s");
		expect(humanSecs(42)).toBe("42s");
		expect(humanSecs(60)).toBe("1m");
		expect(humanSecs(252)).toBe("4m12s");
		expect(humanSecs(1620)).toBe("27m");
	});
});
