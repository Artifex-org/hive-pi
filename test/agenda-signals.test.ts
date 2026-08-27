import { describe, expect, it } from "vitest";
import { deriveSignals, planSignalOf, tasksSignalOf } from "../extensions/agenda/signals.ts";

const taskEntry = (tasks: Array<{ status: string }>) => ({
	customType: "tasks",
	data: { tasks },
});

const planEntry = (data: Record<string, unknown>) => ({ customType: "plan", data });

describe("tasksSignalOf", () => {
	it("counts by status from the NEWEST tasks entry", () => {
		const entries = [
			taskEntry([{ status: "pending" }]),
			taskEntry([{ status: "pending" }, { status: "in_progress" }, { status: "completed" }]),
		];
		expect(tasksSignalOf(entries)).toEqual({ total: 3, pending: 1, inProgress: 1, completed: 1 });
	});

	it("is empty when no tasks entry exists", () => {
		expect(tasksSignalOf([{ customType: "plan", data: {} }])).toEqual({
			total: 0,
			pending: 0,
			inProgress: 0,
			completed: 0,
		});
	});

	it("ignores malformed task rows rather than throwing", () => {
		const entries = [taskEntry([{ status: "pending" }, {} as { status: string }, null as never])];
		expect(tasksSignalOf(entries).total).toBe(1);
	});
});

describe("planSignalOf", () => {
	it("reads phase, revision, goal and counts steps across blocks", () => {
		const entries = [
			planEntry({
				phase: "ready",
				revision: 4,
				goal: "PR green",
				blocks: [
					{ type: "steps", steps: [{ id: "a" }, { id: "b" }] },
					{ type: "text", markdown: "x" },
					{ type: "steps", steps: [{ id: "c" }] },
				],
			}),
		];
		expect(planSignalOf(entries)).toEqual({ phase: "ready", revision: 4, stepCount: 3, goal: "PR green" });
	});

	it("null phase when no plan entry exists", () => {
		expect(planSignalOf([]).phase).toBeNull();
	});

	it("rejects an invalid phase but keeps the rest", () => {
		const signal = planSignalOf([planEntry({ phase: "bogus", revision: 1, blocks: [] })]);
		expect(signal.phase).toBeNull();
		expect(signal.revision).toBe(1);
	});
});

describe("deriveSignals", () => {
	it("takes the NEWEST user prompt and counts user turns", () => {
		const branch = [
			{ message: { role: "user", content: "first ask" } },
			{ message: { role: "assistant", content: "answer" } },
			{ message: { role: "user", content: [{ type: "text", text: "second ask" }] } },
		];
		const signals = deriveSignals([], branch);
		expect(signals.lastUserPrompt).toBe("second ask");
		expect(signals.userTurns).toBe(2);
	});

	it("skips whitespace-only user turns", () => {
		const signals = deriveSignals([], [{ message: { role: "user", content: "  " } }]);
		expect(signals.userTurns).toBe(0);
		expect(signals.lastUserPrompt).toBe("");
	});
});
