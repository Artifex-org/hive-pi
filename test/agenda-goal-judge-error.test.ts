/**
 * The last evaluator error is KEPT, not just counted. The 2026-09-03..06
 * outage — every judge run failing in ~6s — could not be diagnosed from disk,
 * because the message was used once and dropped.
 */

import { describe, expect, it } from "vitest";
import {
	applyJudgeError,
	applyVerdict,
	createGoal,
	MAX_JUDGE_ERROR_CHARS,
	rehydrateGoal,
} from "../extensions/agenda/goal-state.ts";

describe("lastJudgeError", () => {
	it("records the message and the time", () => {
		const { goal } = applyJudgeError(createGoal("g", "c", 1), "evaluator exited 1: 402 insufficient credits", 1234, 0);
		expect(goal.lastJudgeError).toEqual({ message: "evaluator exited 1: 402 insufficient credits", at: 1234 });
	});

	it("caps a long stderr tail", () => {
		const { goal } = applyJudgeError(createGoal("g", "c", 1), "x".repeat(5000), 1, 0);
		expect(goal.lastJudgeError?.message.length).toBe(MAX_JUDGE_ERROR_CHARS);
	});

	it("survives a later verdict, because the question is asked after the fact", () => {
		const failed = applyJudgeError(createGoal("g", "c", 1), "evaluator timed out", 10, 0).goal;
		const judged = applyVerdict(failed, { ok: false, reason: "not yet", pending: false }, 20, 0).goal;
		expect(judged.lastJudgeError).toEqual({ message: "evaluator timed out", at: 10 });
		expect(judged.ledger.judgeErrors).toBe(0);
	});

	it("round-trips through the persisted session entry, and a malformed one is dropped", () => {
		const failed = applyJudgeError(createGoal("g", "c", 1), "evaluator timed out", 10, 0).goal;
		const restored = rehydrateGoal([{ customType: "agenda", data: JSON.parse(JSON.stringify(failed)) }]);
		expect(restored?.lastJudgeError).toEqual({ message: "evaluator timed out", at: 10 });
		const bad = rehydrateGoal([{ customType: "agenda", data: { ...failed, lastJudgeError: { message: 7 } } }]);
		expect(bad?.lastJudgeError).toBeUndefined();
	});
});
