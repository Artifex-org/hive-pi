/**
 * The task-list fold.
 *
 * The assertions that matter here are about state a careless implementation
 * corrupts silently: id reuse after deletion (which re-points `blockedBy` edges
 * at the wrong task), an unknown id quietly becoming a second task for the same
 * work, and rehydration losing counters so a resumed session believes it is
 * starting fresh.
 */

import { describe, expect, it } from "vitest";
import {
	applyWrites,
	counts,
	danglingBlockers,
	emptyTasks,
	findTask,
	rehydrateTasks,
	TASKS_ENTRY_TYPE,
	type TaskListState,
	toEntry,
	validateSnapshot,
} from "../extensions/tasks/state.ts";

const NOW = 1_700_000_000_000;

const seed = (...subjects: string[]): TaskListState =>
	applyWrites(
		emptyTasks,
		subjects.map((subject) => ({ subject })),
		NOW,
	).state;

describe("applyWrites — creation", () => {
	it("creates tasks with sequential ids and a pending default", () => {
		const result = applyWrites(emptyTasks, [{ subject: "first" }, { subject: "second" }], NOW);
		expect(result.created).toEqual(["1", "2"]);
		expect(result.state.tasks.map((t) => t.status)).toEqual(["pending", "pending"]);
		expect(result.state.nextId).toBe(3);
	});

	it("refuses a create with no subject rather than inventing one", () => {
		const result = applyWrites(emptyTasks, [{ description: "detail but no title" }], NOW);
		expect(result.created).toEqual([]);
		expect(result.problems).toEqual(["write #1: a new task needs a subject"]);
	});

	it("applies the rest of a batch when one write is bad", () => {
		const result = applyWrites(emptyTasks, [{ subject: "good" }, { description: "bad" }, { subject: "also good" }], NOW);
		expect(result.created).toEqual(["1", "2"]);
		expect(result.problems).toHaveLength(1);
	});

	it("treats a blank subject as absent", () => {
		const result = applyWrites(emptyTasks, [{ subject: "   " }], NOW);
		expect(result.problems).toEqual(["write #1: a new task needs a subject"]);
	});
});

describe("applyWrites — updates", () => {
	it("reports an unknown id instead of creating a second task for the same work", () => {
		const state = seed("real task");
		const result = applyWrites(state, [{ id: "99", status: "completed" }], NOW);
		expect(result.problems).toEqual(['write #1: unknown task id "99"']);
		expect(result.state.tasks).toHaveLength(1);
		expect(result.created).toEqual([]);
	});

	it("leaves omitted fields alone", () => {
		const state = applyWrites(emptyTasks, [{ subject: "s", description: "d", activeForm: "a" }], NOW).state;
		const result = applyWrites(state, [{ id: "1", status: "in_progress" }], NOW + 1);
		const task = findTask(result.state, "1");
		expect(task?.description).toBe("d");
		expect(task?.activeForm).toBe("a");
		expect(task?.status).toBe("in_progress");
		expect(task?.updatedAt).toBe(NOW + 1);
	});

	it("rejects an unknown status without touching the task", () => {
		const state = seed("s");
		const result = applyWrites(state, [{ id: "1", status: "done" as never }], NOW);
		expect(result.problems).toEqual(['write #1: unknown status "done"']);
		expect(findTask(result.state, "1")?.status).toBe("pending");
	});

	it("clears an owner on null and sets it on a string", () => {
		const state = applyWrites(emptyTasks, [{ subject: "s", owner: "worker-1" }], NOW).state;
		expect(findTask(state, "1")?.owner).toBe("worker-1");
		const cleared = applyWrites(state, [{ id: "1", owner: null }], NOW).state;
		expect(findTask(cleared, "1")?.owner).toBeUndefined();
	});
});

describe("applyWrites — deletion", () => {
	it("removes the task and never reuses its id", () => {
		const state = seed("one", "two");
		const afterDelete = applyWrites(state, [{ id: "2", status: "deleted" }], NOW);
		expect(afterDelete.removed).toEqual(["2"]);
		expect(afterDelete.state.tasks).toHaveLength(1);

		// The load-bearing assertion: a recycled "2" would silently inherit every
		// `blockedBy: ["2"]` edge still pointing at the deleted task.
		const afterCreate = applyWrites(afterDelete.state, [{ subject: "three" }], NOW);
		expect(afterCreate.created).toEqual(["3"]);
	});

	it("refuses to delete without an id", () => {
		const result = applyWrites(seed("one"), [{ status: "deleted" }], NOW);
		expect(result.problems).toEqual(["write #1: cannot delete without an id"]);
		expect(result.state.tasks).toHaveLength(1);
	});
});

describe("blockedBy is advisory", () => {
	it("does not stop a blocked task from starting", () => {
		const state = applyWrites(emptyTasks, [{ subject: "a" }, { subject: "b", blockedBy: ["1"] }], NOW).state;
		const result = applyWrites(state, [{ id: "2", status: "in_progress" }], NOW);
		expect(result.problems).toEqual([]);
		expect(findTask(result.state, "2")?.status).toBe("in_progress");
	});

	it("reports a dangling edge and leaves it in place", () => {
		const state = applyWrites(emptyTasks, [{ subject: "a" }, { subject: "b", blockedBy: ["1"] }], NOW).state;
		const afterDelete = applyWrites(state, [{ id: "1", status: "deleted" }], NOW).state;
		expect(danglingBlockers(afterDelete)).toEqual([{ id: "2", missing: ["1"] }]);
		expect(findTask(afterDelete, "2")?.blockedBy).toEqual(["1"]);
	});
});

describe("counts", () => {
	it("buckets every status", () => {
		const state = applyWrites(
			emptyTasks,
			[{ subject: "a", status: "completed" }, { subject: "b", status: "in_progress" }, { subject: "c" }],
			NOW,
		).state;
		expect(counts(state)).toEqual({ pending: 1, inProgress: 1, completed: 1 });
	});
});

describe("persistence round trip", () => {
	it("survives entry → snapshot → entry", () => {
		const state = applyWrites(
			emptyTasks,
			[{ subject: "a", description: "d", owner: "w1" }, { subject: "b", blockedBy: ["1"] }],
			NOW,
		).state;
		const restored = validateSnapshot(toEntry(state));
		expect(restored).toEqual(state);
	});

	it("rejects a snapshot from a schema version it cannot understand", () => {
		const entry = { ...toEntry(seed("a")), schemaVersion: 2 };
		expect(validateSnapshot(entry)).toBeNull();
	});

	it("repairs a nextId that trails the live maximum", () => {
		// A hand-edited or truncated snapshot must not hand the next task an id
		// that already exists.
		const entry = { ...toEntry(seed("a", "b", "c")), nextId: 1 };
		expect(validateSnapshot(entry)?.nextId).toBe(4);
	});

	it("drops malformed tasks rather than the whole list", () => {
		const entry = toEntry(seed("good")) as Record<string, unknown>;
		entry.tasks = [...(entry.tasks as unknown[]), { id: "9" }, null, { subject: "no id" }];
		const restored = validateSnapshot(entry);
		expect(restored?.tasks.map((t) => t.subject)).toEqual(["good"]);
	});
});

describe("rehydrateTasks", () => {
	const entryOf = (state: TaskListState) => ({ customType: TASKS_ENTRY_TYPE, data: toEntry(state) });

	it("takes the newest snapshot", () => {
		const first = seed("old");
		const second = seed("old", "new");
		expect(rehydrateTasks([entryOf(first), entryOf(second)])?.tasks).toHaveLength(2);
	});

	it("ignores entries belonging to other extensions", () => {
		const state = seed("mine");
		const entries = [entryOf(state), { customType: "agenda", data: { kind: "goal" } }];
		expect(rehydrateTasks(entries)?.tasks.map((t) => t.subject)).toEqual(["mine"]);
	});

	it("skips past a corrupt newest entry to the last good one", () => {
		const state = seed("mine");
		const entries = [entryOf(state), { customType: TASKS_ENTRY_TYPE, data: { kind: "tasks", schemaVersion: 99 } }];
		expect(rehydrateTasks(entries)?.tasks).toHaveLength(1);
	});

	it("returns null when nothing was ever persisted", () => {
		expect(rehydrateTasks([])).toBeNull();
	});
});
