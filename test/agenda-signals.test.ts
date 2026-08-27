import { describe, expect, it } from "vitest";
import { deriveSignals, planSignalOf, tasksSignalOf } from "../extensions/agenda/signals.ts";

/**
 * A plan entry carrying ONE lane, which is where todos live since HIV-2904.
 *
 * The signal used to read a `tasks` entry; there is no such entry now, so the
 * fixture builds the document the conductor actually folds. Everything the
 * assertions below check — counting by status, taking the newest, surviving a
 * malformed row — is unchanged, and each is still the thing that would break
 * the conductor's "is the work done" question if it regressed.
 */
const taskEntry = (tasks: Array<{ status: string }>) => ({
	customType: "plan",
	data: {
		kind: "plan",
		schemaVersion: 1,
		doc: {
			title: "",
			goal: "",
			phase: "none",
			revision: 1,
			progress: 0,
			nextId: 99,
			createdAt: 0,
			updatedAt: 0,
			blocks: [
				{
					id: "lane",
					type: "steps",
					kind: "execute",
					createdAt: 0,
					updatedAt: 0,
					// A row with no status at all is passed through as-is, so a
					// malformed one stays malformed all the way to the fold — which
					// is the point of the third test below.
					steps: tasks.map((task, index) =>
						task && typeof task.status === "string"
							? {
									id: `i${index}`,
									title: `item ${index}`,
									// The conductor speaks the todo vocabulary; the
									// document stores `done`, and the signal translates.
									status: task.status === "completed" ? "done" : task.status,
								}
							: task,
					),
				},
			],
		},
	},
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
