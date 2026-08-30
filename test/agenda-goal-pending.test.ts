/**
 * "Not finished yet" is not the same answer as "not done".
 *
 * MEASURED over 688 goals to 2026-08-29: **256 capped against 191 achieved**,
 * and a capped goal always ran its budget out — median 8 iterations of a
 * maximum 8. Two thirds of them (171) capped while the work the condition names
 * was still IN FLIGHT, the judge answering truthfully:
 *
 *     "Run #2663 for PR #3584 is still running: 1 of 10 tasks succeeded,
 *      9 pending — not all required checks are green yet."
 *
 * 28.3M evaluator tokens went into capped goals against 7.8M into achieved
 * ones. An agent correctly waiting on a 40-minute CI run was spending its whole
 * goal budget being asked whether the run had finished.
 */

import { describe, expect, it } from "vitest";

import { injectionFor, metricFor } from "../extensions/agenda/goal.ts";
import {
	applyVerdict,
	createGoal,
	GOAL_ENTRY_TYPE,
	MAX_PENDING,
	rehydrateGoal,
	type GoalItem,
} from "../extensions/agenda/goal-state.ts";
import { parseVerdict } from "../extensions/agenda/verdict.ts";

/** rehydrateGoal reads session ENTRIES, not a bare goal. */
const entriesFor = (g: GoalItem) => [{ customType: GOAL_ENTRY_TYPE, data: JSON.parse(JSON.stringify(g)) }];

const NOW = 1_000_000;
const goal = (): GoalItem => createGoal("g1", "every required check is green", NOW);

/** The measured shape: a live count that differs on every poll. */
const stillRunning = (succeeded: number) => ({
	ok: false,
	pending: true,
	reason: `Run #2663 is still running: ${succeeded} of 10 tasks succeeded — not all checks are green yet.`,
});

describe("parseVerdict — the third answer", () => {
	it("reads pending off the wire", () => {
		const r = parseVerdict('{"ok": false, "reason": "CI still running", "pending": true}');
		expect(r).toEqual({ kind: "verdict", verdict: { ok: false, reason: "CI still running", pending: true } });
	});

	it("leaves an ordinary verdict's shape untouched", () => {
		// Every caller compares whole verdicts, so `pending: false` on every
		// answer would be the same information in a different object.
		const r = parseVerdict('{"ok": false, "reason": "the PR was never opened"}');
		expect(r).toEqual({ kind: "verdict", verdict: { ok: false, reason: "the PR was never opened" } });
	});

	it("is lenient about a malformed pending, where ok is strict", () => {
		// `ok` decides whether the goal CLOSES; `pending` only decides whether an
		// iteration is spent, so a bad one costs exactly what today costs.
		const r = parseVerdict('{"ok": false, "reason": "waiting", "pending": "yes"}');
		expect(r).toEqual({ kind: "verdict", verdict: { ok: false, reason: "waiting" } });
	});

	it("lets ok:true win over a contradictory pending", () => {
		// A judge that says both has contradicted itself; the safe reading is the
		// one that terminates.
		const r = parseVerdict('{"ok": true, "reason": "all green", "pending": true}');
		expect(r).toEqual({ kind: "verdict", verdict: { ok: true, reason: "all green" } });
	});
});

describe("a pending verdict spends nothing", () => {
	it("does not charge an iteration", () => {
		const { goal: after, outcome } = applyVerdict(goal(), stillRunning(1), NOW, 500);
		expect(outcome.kind).toBe("pending");
		expect(after.ledger.iterations).toBe(0);
		expect(after.state).toBe("active");
	});

	it("survives the whole of a CI run that an iteration budget would not", () => {
		// The regression this exists to prevent, at full size: eight polls is the
		// entire default iteration budget, and every one of them reports a
		// different count.
		let g = goal();
		for (let i = 0; i < 8; i++) g = applyVerdict(g, stillRunning(i), NOW + i, 100).goal;
		expect(g.ledger.iterations).toBe(0);
		expect(g.state).toBe("active");

		const done = applyVerdict(g, { ok: true, reason: "all 10 checks green" }, NOW + 9, 100);
		expect(done.outcome.kind).toBe("achieved");
		expect(done.goal.state).toBe("achieved");
	});

	it("says nothing to the agent while it waits", () => {
		// The saving. An agent waiting on CI is already doing the right thing;
		// "keep going" only tells it to poll, billing a turn for news that has
		// not arrived.
		const { outcome } = applyVerdict(goal(), stillRunning(2), NOW, 100);
		expect(injectionFor(outcome)).toBeNull();
	});

	it("counts as skip, not fail", () => {
		const { outcome } = applyVerdict(goal(), stillRunning(2), NOW, 100);
		expect(metricFor(outcome)).toBe("skip");
	});

	it("still charges the evaluator tokens it actually spent", () => {
		const { goal: after } = applyVerdict(goal(), stillRunning(1), NOW, 700);
		expect(after.ledger.tokens).toBe(700);
	});
});

describe("a pending goal still terminates", () => {
	it("gives up after MAX_PENDING and charges the verdict normally", () => {
		// "Still running" is exactly what a job that will NEVER finish reports,
		// so the wait is bounded.
		let g = goal();
		for (let i = 0; i < MAX_PENDING - 1; i++) g = applyVerdict(g, stillRunning(i), NOW + i, 10).goal;
		expect(g.ledger.iterations).toBe(0);

		const last = applyVerdict(g, stillRunning(99), NOW + 99, 10);
		expect(last.outcome.kind).toBe("continue");
		expect(last.goal.ledger.iterations).toBe(1);
	});

	it("stops waiting the moment the token budget is gone", () => {
		let g = createGoal("g2", "checks green", NOW, { budget: { tokens: 100 } });
		g = applyVerdict(g, stillRunning(1), NOW, 500).goal;
		const next = applyVerdict(g, stillRunning(2), NOW + 1, 500);
		expect(next.outcome.kind).toBe("budget_exhausted");
	});
});

describe("the streak", () => {
	it("clears once the verdict becomes gradeable", () => {
		let g = applyVerdict(goal(), stillRunning(1), NOW, 10).goal;
		expect(g.ledger.pendingStreak).toBe(1);
		g = applyVerdict(g, { ok: false, reason: "the run failed on lint" }, NOW + 1, 10).goal;
		expect(g.ledger.pendingStreak).toBe(0);
	});

	it("does NOT reset on a changed reason, unlike noProgressStreak", () => {
		// The whole reason a separate counter was needed: a pending reason names
		// live counts that differ every poll, so a streak that reset on a changed
		// reason would never reach its cap — which is how the binary verdict let
		// these goals run to the iteration cap.
		let g = goal();
		for (let i = 0; i < 3; i++) g = applyVerdict(g, stillRunning(i), NOW + i, 10).goal;
		expect(g.ledger.pendingStreak).toBe(3);
	});

	it("survives a rehydrate", () => {
		const g = applyVerdict(goal(), stillRunning(1), NOW, 10).goal;
		expect(rehydrateGoal(entriesFor(g))?.ledger.pendingStreak).toBe(1);
	});

	it("defaults to zero for a goal written before the field existed", () => {
		// The upgrade path: every goal already on disk predates the field, and a
		// rehydrate that produced `undefined` would make the first comparison
		// against MAX_PENDING NaN.
		const old = JSON.parse(JSON.stringify(goal())) as { ledger: Record<string, unknown> };
		delete old.ledger.pendingStreak;
		expect(rehydrateGoal([{ customType: GOAL_ENTRY_TYPE, data: old }])?.ledger.pendingStreak).toBe(0);
	});
});
