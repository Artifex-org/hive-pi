/**
 * Linear-backed task lists.
 *
 * Everything here tests the FOLD, not the fetch. The assertions that matter are
 * about the sync's direction: what Linear is allowed to overwrite (text), what
 * it is not (local status), and what is reported rather than silently applied.
 * A sync that clobbers a status the human just set is the failure that makes
 * people stop trusting the feature, and it is invisible in a happy-path test.
 */

import { describe, expect, it } from "vitest";
import {
	describeHydrate,
	flattenTree,
	linkedTasks,
	mapNode,
	planHydrate,
	pushBody,
	statusFor,
} from "../extensions/tasks/linear.ts";
import { applyWrites, emptyTasks, findTask, type TaskListState } from "../extensions/tasks/state.ts";

const NOW = 1_700_000_000_000;

const node = (identifier: string, type: string, over: Record<string, unknown> = {}) => ({
	identifier,
	title: `${identifier} title`,
	url: `https://linear.app/x/issue/${identifier}`,
	state: { name: type === "started" ? "In Progress" : type, type },
	...over,
});

const apply = (state: TaskListState, sources: Parameters<typeof planHydrate>[1]) => {
	const plan = planHydrate(state, sources);
	return { plan, state: applyWrites(state, plan.writes, NOW).state };
};

describe("statusFor", () => {
	it("maps the states that represent work", () => {
		expect(statusFor("completed")).toBe("completed");
		expect(statusFor("started")).toBe("in_progress");
		expect(statusFor("backlog")).toBe("pending");
		expect(statusFor("unstarted")).toBe("pending");
	});

	it("imports neither canceled nor triage", () => {
		// A canceled issue is not work. Importing it as pending manufactures a
		// to-do the human already decided against.
		expect(statusFor("canceled")).toBeNull();
		expect(statusFor("triage")).toBeNull();
	});
});

describe("mapNode / flattenTree", () => {
	it("drops a node with no identifier", () => {
		expect(mapNode({ title: "orphan" })).toBeNull();
	});

	it("falls back to the identifier when the title is blank", () => {
		expect(mapNode(node("AUR-1", "backlog", { title: "  " }))?.title).toBe("AUR-1");
	});

	it("truncates a long description rather than pasting an essay into a glance surface", () => {
		const mapped = mapNode(node("AUR-1", "backlog", { description: "x".repeat(1000) }));
		expect(mapped?.description?.length).toBeLessThanOrEqual(400);
		expect(mapped?.description?.endsWith("…")).toBe(true);
	});

	it("keeps the parent at the head, then children in order", () => {
		const tree = { ...node("AUR-1", "backlog"), children: { nodes: [node("AUR-2", "backlog"), node("AUR-3", "started")] } };
		expect(flattenTree(tree).map((s) => s.identifier)).toEqual(["AUR-1", "AUR-2", "AUR-3"]);
	});

	it("returns nothing for an unusable root", () => {
		expect(flattenTree(null)).toEqual([]);
	});
});

describe("planHydrate — first read", () => {
	it("creates one task per importable issue, carrying the key", () => {
		const { plan, state } = apply(emptyTasks, [
			mapNode(node("AUR-1", "backlog"))!,
			mapNode(node("AUR-2", "started"))!,
		]);
		expect(plan.writes).toHaveLength(2);
		expect(state.tasks.map((t) => t.linearKey)).toEqual(["AUR-1", "AUR-2"]);
		expect(state.tasks.map((t) => t.status)).toEqual(["pending", "in_progress"]);
	});

	it("reports what it skipped instead of dropping it silently", () => {
		const plan = planHydrate(emptyTasks, [mapNode(node("AUR-1", "backlog"))!, mapNode(node("AUR-9", "canceled"))!]);
		expect(plan.writes).toHaveLength(1);
		expect(plan.skipped).toEqual([{ key: "AUR-9", reason: "canceled" }]);
		expect(describeHydrate(plan).join("\n")).toContain("skipped AUR-9");
	});
});

describe("planHydrate — re-read", () => {
	it("refreshes text from Linear, which owns it", () => {
		const first = apply(emptyTasks, [mapNode(node("AUR-1", "backlog"))!]).state;
		const second = apply(first, [mapNode(node("AUR-1", "backlog", { title: "renamed upstream" }))!]).state;
		expect(second.tasks).toHaveLength(1);
		expect(second.tasks[0].subject).toBe("renamed upstream");
	});

	it("does NOT overwrite local status, and reports the drift instead", () => {
		// The load-bearing case. Local progress must survive a re-read, or the
		// human's own edit vanishes and the sync becomes untrustworthy.
		let state = apply(emptyTasks, [mapNode(node("AUR-1", "backlog"))!]).state;
		state = applyWrites(state, [{ id: "1", status: "in_progress" }], NOW).state;

		const { plan, state: after } = apply(state, [mapNode(node("AUR-1", "backlog"))!]);
		expect(findTask(after, "1")?.status).toBe("in_progress");
		expect(plan.drifted).toEqual([{ key: "AUR-1", local: "in_progress", linear: "backlog" }]);
		expect(describeHydrate(plan).join("\n")).toContain("local status kept");
	});

	it("does not duplicate a task on a second read", () => {
		const first = apply(emptyTasks, [mapNode(node("AUR-1", "backlog"))!]).state;
		const second = apply(first, [mapNode(node("AUR-1", "backlog"))!]).state;
		expect(second.tasks).toHaveLength(1);
	});

	it("reports a linked task absent from this read, and leaves it in place", () => {
		// The issue may simply be outside this parent's tree; deleting on absence
		// would destroy work on the strength of a narrower query.
		const first = apply(emptyTasks, [mapNode(node("AUR-1", "backlog"))!, mapNode(node("AUR-2", "backlog"))!]).state;
		const { plan, state: after } = apply(first, [mapNode(node("AUR-1", "backlog"))!]);
		expect(plan.orphaned).toEqual(["AUR-2"]);
		expect(after.tasks).toHaveLength(2);
		expect(describeHydrate(plan).join("\n")).toContain("left in place");
	});

	it("leaves unlinked local tasks completely alone", () => {
		const local = applyWrites(emptyTasks, [{ subject: "my own note" }], NOW).state;
		const { plan, state } = apply(local, [mapNode(node("AUR-1", "backlog"))!]);
		expect(plan.orphaned).toEqual([]);
		expect(state.tasks.map((t) => t.subject)).toEqual(["my own note", "AUR-1 title"]);
	});
});

describe("write-back", () => {
	const linked = () =>
		applyWrites(
			emptyTasks,
			[
				{ subject: "done thing", status: "completed", linearKey: "AUR-1" },
				{ subject: "doing thing", status: "in_progress", linearKey: "AUR-1" },
				{ subject: "other issue", linearKey: "AUR-2" },
				{ subject: "unlinked" },
			],
			NOW,
		).state;

	it("linkedTasks excludes anything with no key", () => {
		expect(linkedTasks(linked()).map((t) => t.subject)).toEqual(["done thing", "doing thing", "other issue"]);
	});

	it("builds one body per issue, containing only that issue's tasks", () => {
		const body = pushBody(linked().tasks, "AUR-1");
		expect(body).toContain("- [x] done thing");
		expect(body).toContain("- [ ] doing thing");
		expect(body).toContain("_(in progress)_");
		// One comment per issue, not one per task — six notifications for six
		// checkboxes trains everyone to mute the project.
		expect(body).not.toContain("other issue");
		expect(body).not.toContain("unlinked");
	});
});

describe("linearKey round trip", () => {
	it("survives a write, an update, and an unlink", () => {
		let state = applyWrites(emptyTasks, [{ subject: "s", linearKey: "AUR-7" }], NOW).state;
		expect(findTask(state, "1")?.linearKey).toBe("AUR-7");
		state = applyWrites(state, [{ id: "1", status: "completed" }], NOW).state;
		expect(findTask(state, "1")?.linearKey).toBe("AUR-7");
		state = applyWrites(state, [{ id: "1", linearKey: null }], NOW).state;
		expect(findTask(state, "1")?.linearKey).toBeUndefined();
	});
});
