/**
 * Rendering.
 *
 * `renderList` is not cosmetic: the list is stored where the LLM structurally
 * cannot see it, so this output is the model's ONLY view of task state. A field
 * missing here is a field the model cannot act on, which is why the assertions
 * below are about completeness (every id, every blocker, every owner) rather
 * than about layout.
 */

import { describe, expect, it } from "vitest";
import { renderList, renderTaskDetail, renderWriteResult, summaryLine } from "../extensions/tasks/render.ts";
import { applyWrites, emptyTasks, findTask, type TaskListState } from "../extensions/tasks/state.ts";

const NOW = 1_700_000_000_000;

const build = (...writes: Parameters<typeof applyWrites>[1]): TaskListState =>
	applyWrites(emptyTasks, writes, NOW).state;

describe("summaryLine", () => {
	it("is undefined for an empty list, so the widget costs no row", () => {
		expect(summaryLine(emptyTasks)).toBeUndefined();
	});

	it("counts each bucket", () => {
		const state = build({ subject: "a", status: "completed" }, { subject: "b", status: "in_progress" }, { subject: "c" });
		const line = summaryLine(state);
		expect(line).toContain("☐ 1");
		expect(line).toContain("⧗ 1");
		expect(line).toContain("☑ 1");
	});
});

describe("renderList", () => {
	it("says so plainly when there is nothing", () => {
		expect(renderList(emptyTasks)).toBe("No tasks.");
	});

	it("shows every id, because the model addresses tasks by id", () => {
		const state = build({ subject: "alpha" }, { subject: "beta" }, { subject: "gamma" });
		const out = renderList(state);
		for (const id of ["1", "2", "3"]) expect(out).toMatch(new RegExp(`\\b${id}\\b`));
	});

	it("keeps insertion order rather than grouping by status", () => {
		// Re-sorting would move ids between turns and make a plan read as though it
		// changed when only its rendering did.
		const state = build({ subject: "first", status: "completed" }, { subject: "second" });
		const lines = renderList(state).split("\n");
		expect(lines[1]).toContain("first");
		expect(lines[2]).toContain("second");
	});

	it("surfaces owner and blockers", () => {
		const state = build({ subject: "a" }, { subject: "b", blockedBy: ["1"], owner: "worker-scout-1" });
		const out = renderList(state);
		expect(out).toContain("[worker-scout-1]");
		expect(out).toContain("blocked by 1");
	});

	it("notes a dangling blocker without dropping it", () => {
		let state = build({ subject: "a" }, { subject: "b", blockedBy: ["1"] });
		state = applyWrites(state, [{ id: "1", status: "deleted" }], NOW).state;
		const out = renderList(state);
		expect(out).toContain("missing task(s) 1");
		expect(out).toContain("blocked by 1");
	});

	it("includes descriptions only when asked", () => {
		const state = build({ subject: "a", description: "the long form" });
		expect(renderList(state)).not.toContain("the long form");
		expect(renderList(state, { verbose: true })).toContain("the long form");
	});
});

describe("renderWriteResult", () => {
	it("always ends with the whole list — it is the model's only view of it", () => {
		const result = applyWrites(emptyTasks, [{ subject: "a" }, { subject: "b" }], NOW);
		const out = renderWriteResult(result, result.state);
		expect(out).toContain("created 1, 2");
		expect(out).toContain("tasks: 2 to do");
	});

	it("puts problems first, where they will not be skimmed past", () => {
		const state = build({ subject: "a" });
		const result = applyWrites(state, [{ id: "99", status: "completed" }], NOW);
		const out = renderWriteResult(result, result.state);
		expect(out.split("\n")[0]).toBe('! write #1: unknown task id "99"');
		// The whole point of a partial apply is that the caller still sees state.
		expect(out).toContain("tasks: 1 to do");
	});

	it("reports a no-op as a no-op rather than as success", () => {
		const state = build({ subject: "a" });
		const result = applyWrites(state, [], NOW);
		expect(renderWriteResult(result, result.state)).toContain("no changes");
	});
});

describe("renderTaskDetail", () => {
	it("is undefined for an unknown task", () => {
		expect(renderTaskDetail(undefined)).toBeUndefined();
	});

	it("carries the fields the list view omits", () => {
		const state = build({ subject: "a", description: "why", activeForm: "Doing a", owner: "w1" });
		const out = renderTaskDetail(findTask(state, "1"));
		expect(out).toContain("why");
		expect(out).toContain("Doing a");
		expect(out).toContain("w1");
	});
});
