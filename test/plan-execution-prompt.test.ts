import { describe, expect, it } from "vitest";
import { isExecuting } from "../extensions/plan/index.ts";
import { buildExecutionPrompt, buildPlanPrompt, EXECUTION_GUIDANCE } from "../extensions/plan/prompt.ts";
import type { PlanDoc } from "../extensions/plan/state.ts";

const plan = (phase: string, statuses: string[]) =>
	({ phase, blocks: [{ type: "steps", id: "steps", steps: statuses.map((status, i) => ({ id: String(i), title: `s${i}`, status })) }] }) as unknown as PlanDoc;

describe("execution guidance after approval (HIV-3013)", () => {
	it("applies to an approved plan with open steps only", () => {
		expect(isExecuting(plan("approved", ["done", "in_progress"]))).toBe(true);
		expect(isExecuting(plan("approved", ["pending"]))).toBe(true);
		expect(isExecuting(plan("approved", ["done", "skipped", "blocked"]))).toBe(false);
		expect(isExecuting(plan("ready", ["pending"]))).toBe(false);
		expect(isExecuting(plan("none", []))).toBe(false);
	});

	it("keeps the plan-mode prompt carrying the same section", () => {
		expect(buildPlanPrompt()).toContain(EXECUTION_GUIDANCE);
		expect(buildExecutionPrompt()).toContain(EXECUTION_GUIDANCE);
	});

	it("asks for every step to be closed and for a retitle", () => {
		expect(EXECUTION_GUIDANCE).toContain("never leave one `in_progress`");
		expect(EXECUTION_GUIDANCE).toContain("session_title");
	});

	// A fixed string: the system prompt changes only at the approval and
	// completion transitions, so the prompt cache holds between them.
	it("is stable across calls", () => {
		expect(buildExecutionPrompt()).toBe(buildExecutionPrompt());
	});
});
