/**
 * The goal state machine and its persistence — pure folds, no pi, no clock.
 *
 * The two properties worth the most here:
 *  - a judge ERROR is never an unmet condition, and never spends an iteration;
 *  - counters REHYDRATE rather than reset, or a persisted budget is refreshed
 *    on every resume and can never bind.
 */

import { describe, expect, it } from "vitest";
import {
	applyJudgeError,
	applyVerdict,
	createGoal,
	DEFAULT_MAX_ITERATIONS,
	type GoalItem,
	isTerminal,
	MAX_JUDGE_ERRORS,
	MAX_NO_PROGRESS,
	rehydrateGoal,
	validateGoal,
	withState,
} from "../extensions/agenda/goal-state.ts";

const T0 = 1_700_000_000_000;

function goal(overrides: Partial<GoalItem> = {}): GoalItem {
	return { ...createGoal("g1", "pytest -q exits 0", T0), ...overrides };
}

describe("applyVerdict — achievement", () => {
	it("closes the goal when the condition holds", () => {
		const { goal: next, outcome } = applyVerdict(goal(), { ok: true, reason: "all green" }, T0 + 1, 100);
		expect(next.state).toBe("achieved");
		expect(outcome.kind).toBe("achieved");
		expect(isTerminal(next.state)).toBe(true);
	});

	it("beats the cap — a goal met on its last allowed iteration is achieved, not capped", () => {
		const almost = goal({
			ledger: { ...goal().ledger, iterations: DEFAULT_MAX_ITERATIONS - 1 },
		});
		const { goal: next } = applyVerdict(almost, { ok: true, reason: "done" }, T0 + 1, 0);
		expect(next.state).toBe("achieved");
	});

	it("records the reason so a closed goal is not a rubber stamp", () => {
		const { goal: next } = applyVerdict(goal(), { ok: true, reason: "118 passed" }, T0 + 1, 0);
		expect(next.lastReason).toBe("118 passed");
	});
});

describe("applyVerdict — continuation and the cap", () => {
	it("charges an iteration and reports what is left", () => {
		const { goal: next, outcome } = applyVerdict(goal(), { ok: false, reason: "3 failing" }, T0 + 1, 50);
		expect(next.ledger.iterations).toBe(1);
		expect(outcome).toMatchObject({ kind: "continue", remaining: DEFAULT_MAX_ITERATIONS - 1 });
	});

	it("caps at maxIterations", () => {
		let current = goal();
		for (let i = 0; i < DEFAULT_MAX_ITERATIONS; i++) {
			current = applyVerdict(current, { ok: false, reason: `attempt ${i}` }, T0 + i, 0).goal;
		}
		expect(current.state).toBe("capped");
		expect(current.ledger.iterations).toBe(DEFAULT_MAX_ITERATIONS);
	});

	it("accumulates evaluator token spend", () => {
		let current = goal();
		current = applyVerdict(current, { ok: false, reason: "a" }, T0, 120).goal;
		current = applyVerdict(current, { ok: false, reason: "b" }, T0, 80).goal;
		expect(current.ledger.tokens).toBe(200);
	});
});

describe("applyVerdict — the convergence check", () => {
	it("blocks on the user after repeated identical reasons", () => {
		// A review-shaped condition never terminates otherwise: the critic either
		// manufactures a new objection each turn or repeats the same one forever.
		let current = goal();
		for (let i = 0; i < MAX_NO_PROGRESS; i++) {
			current = applyVerdict(current, { ok: false, reason: "same objection" }, T0 + i, 0).goal;
		}
		expect(current.state).toBe("blocked_user");
	});

	it("counts occurrences, so the first unmet verdict is already a streak of one", () => {
		const first = applyVerdict(goal(), { ok: false, reason: "one" }, T0, 0).goal;
		expect(first.ledger.noProgressStreak).toBe(1);
	});

	it("restarts the count when the reason changes — that IS progress", () => {
		let current = goal();
		current = applyVerdict(current, { ok: false, reason: "one" }, T0, 0).goal;
		current = applyVerdict(current, { ok: false, reason: "one" }, T0, 0).goal;
		expect(current.ledger.noProgressStreak).toBe(2);
		current = applyVerdict(current, { ok: false, reason: "two" }, T0, 0).goal;
		expect(current.ledger.noProgressStreak).toBe(1);
		expect(current.state).toBe("active");
	});

	it("clears the count entirely once the goal is met", () => {
		let current = applyVerdict(goal(), { ok: false, reason: "one" }, T0, 0).goal;
		current = applyVerdict(current, { ok: true, reason: "done" }, T0, 0).goal;
		expect(current.ledger.noProgressStreak).toBe(0);
	});
});

describe("applyVerdict — budgets", () => {
	it("stops on the token budget", () => {
		const budgeted = createGoal("g", "c", T0, { budget: { tokens: 100 } });
		const spent = applyVerdict(budgeted, { ok: false, reason: "x" }, T0 + 1, 150).goal;
		expect(spent.state).toBe("budget_exhausted");
	});

	it("stops on the wall-clock budget", () => {
		const budgeted = createGoal("g", "c", T0, { budget: { wallClockMs: 60_000 } });
		const late = applyVerdict(budgeted, { ok: false, reason: "x" }, T0 + 61_000, 0).goal;
		expect(late.state).toBe("budget_exhausted");
	});

	it("does not stop a goal with no budget, however long it runs", () => {
		const next = applyVerdict(goal(), { ok: false, reason: "x" }, T0 + 999_999_999, 999_999).goal;
		expect(next.state).toBe("active");
	});

	it("still closes an ACHIEVED goal even if the budget ran out on the same turn", () => {
		const budgeted = createGoal("g", "c", T0, { budget: { tokens: 10 } });
		const next = applyVerdict(budgeted, { ok: true, reason: "done" }, T0 + 1, 500).goal;
		expect(next.state).toBe("achieved");
	});
});

describe("applyJudgeError", () => {
	it("does NOT charge an iteration — a failed judge said nothing about the goal", () => {
		const { goal: next, outcome } = applyJudgeError(goal(), "evaluator timed out", T0 + 1, 0);
		expect(next.ledger.iterations).toBe(0);
		expect(next.state).toBe("active");
		expect(outcome.kind).toBe("judge_error");
	});

	it("pauses the goal after consecutive failures rather than looping on a broken evaluator", () => {
		let current = goal();
		for (let i = 0; i < MAX_JUDGE_ERRORS; i++) {
			current = applyJudgeError(current, "boom", T0 + i, 0).goal;
		}
		expect(current.state).toBe("paused");
	});

	it("clears the error streak once a real verdict arrives", () => {
		let current = applyJudgeError(goal(), "boom", T0, 0).goal;
		expect(current.ledger.judgeErrors).toBe(1);
		current = applyVerdict(current, { ok: false, reason: "progress" }, T0, 0).goal;
		expect(current.ledger.judgeErrors).toBe(0);
	});

	it("still bills the tokens the failed evaluator burned", () => {
		const next = applyJudgeError(goal(), "bad json", T0, 90).goal;
		expect(next.ledger.tokens).toBe(90);
	});
});

describe("rehydration", () => {
	it("restores the newest goal entry, ignoring earlier ones", () => {
		const older = withState(goal(), "active", T0);
		const newer = { ...older, condition: "newer condition" };
		const restored = rehydrateGoal([
			{ customType: "agenda", data: older },
			{ customType: "other", data: { kind: "goal" } },
			{ customType: "agenda", data: newer },
		]);
		expect(restored?.condition).toBe("newer condition");
	});

	it("REHYDRATES counters rather than zeroing them", () => {
		// The divergence from Claude Code, and the reason for it: CC resets on
		// resume, but CC enforces no budget. A persisted budget with a resetting
		// spend counter is refreshed on every resume and never binds.
		const spent = goal({ ledger: { ...goal().ledger, iterations: 7, tokens: 50_000, turnsEvaluated: 7 } });
		const restored = rehydrateGoal([{ customType: "agenda", data: spent }]);
		expect(restored?.ledger.iterations).toBe(7);
		expect(restored?.ledger.tokens).toBe(50_000);
	});

	it("a goal at its cap stays capped across a reload", () => {
		const capped = withState(
			goal({ ledger: { ...goal().ledger, iterations: DEFAULT_MAX_ITERATIONS } }),
			"capped",
			T0,
		);
		const restored = rehydrateGoal([{ customType: "agenda", data: capped }]);
		expect(restored?.state).toBe("capped");
		expect(isTerminal(restored?.state ?? "active")).toBe(true);
	});

	it("returns null when there is nothing to restore", () => {
		expect(rehydrateGoal([])).toBeNull();
		expect(rehydrateGoal([{ customType: "something-else", data: {} }])).toBeNull();
	});

	it("skips a malformed entry and keeps looking", () => {
		const good = goal();
		const restored = rehydrateGoal([
			{ customType: "agenda", data: good },
			{ customType: "agenda", data: { kind: "goal", schemaVersion: 1 } }, // no id/condition
		]);
		expect(restored?.condition).toBe(good.condition);
	});
});

describe("validateGoal — defends against hand-edited and future session files", () => {
	it("rejects a newer schemaVersion rather than guessing at its shape", () => {
		expect(validateGoal({ ...goal(), schemaVersion: 2 })).toBeNull();
	});

	it("rejects an unknown state", () => {
		expect(validateGoal({ ...goal(), state: "banana" })).toBeNull();
	});

	it("rejects a missing condition", () => {
		expect(validateGoal({ ...goal(), condition: "" })).toBeNull();
	});

	it("floors maxIterations at 1, so a corrupt 0 cannot mean unbounded", () => {
		const restored = validateGoal({ ...goal(), ledger: { ...goal().ledger, maxIterations: 0 } });
		expect(restored?.ledger.maxIterations).toBe(1);
	});

	it("replaces a non-integer counter with zero instead of propagating NaN", () => {
		const restored = validateGoal({ ...goal(), ledger: { ...goal().ledger, iterations: "lots" } });
		expect(restored?.ledger.iterations).toBe(0);
	});
});
