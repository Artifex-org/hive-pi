import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import tasksExtension, { type TaskListDetails } from "../extensions/tasks/index.ts";
import type { TaskItem } from "../extensions/tasks/state.ts";

/**
 * A minimal stand-in for the pi surface the tasks extension touches.
 *
 * The extension registers tools in its factory, so the only way to assert on
 * what a tool RETURNS is to run the factory and call the registration back. The
 * four members below are exactly what `grep "pi\.|ctx\."` finds in the
 * extension — a harness that grew past that would be testing pi, not us.
 */
type Tool = {
	name: string;
	execute: (id: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

function harness() {
	const tools = new Map<string, Tool>();
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (t: Tool) => tools.set(t.name, t),
		appendEntry: () => {},
		// The deck publication path (HIV-1219): factory-time subscribe, per-write emit.
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;

	tasksExtension(pi);

	const ctx = {
		ui: { setWidget: () => {}, notify: () => {}, confirm: async () => true },
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;

	const call = (name: string, params: unknown) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`no tool ${name}`);
		return tool.execute("call-1", params, undefined, undefined, ctx);
	};
	return { call };
}

const detailsOf = (result: { details?: unknown }) => result.details as TaskListDetails;
const subjects = (tasks: readonly TaskItem[]) => tasks.map((t) => t.subject);

// Before this, `text()` hardcoded `details: {}` — so the structured task list
// never left pi. The only machine-readable thing a consumer received was the
// ARGUMENTS: the writes that were applied, not the list that resulted. That is
// the wrong half; a reader wants the current plan and where the agent is in it.

describe("task tools return the resulting list as details", () => {
	it("TodoWrite reports the state after the writes, not the writes", async () => {
		const { call } = harness();
		const result = await call("TodoWrite", {
			todos: [{ subject: "write the widget" }, { subject: "ship it" }],
		});
		expect(subjects(detailsOf(result).tasks)).toEqual(["write the widget", "ship it"]);
	});

	it("carries status through, which is the whole point of the widget", async () => {
		const { call } = harness();
		const created = await call("TodoWrite", { todos: [{ subject: "one" }, { subject: "two" }] });
		const id = detailsOf(created).tasks[0].id;

		const updated = await call("TaskUpdate", { taskId: id, status: "in_progress" });
		const tasks = detailsOf(updated).tasks;
		// The list is cumulative — an update returns every task, not the one edited.
		expect(tasks).toHaveLength(2);
		expect(tasks.find((t) => t.id === id)?.status).toBe("in_progress");
	});

	it("reflects a deletion", async () => {
		const { call } = harness();
		const created = await call("TodoWrite", { todos: [{ subject: "keep" }, { subject: "drop" }] });
		const doomed = detailsOf(created).tasks[1].id;
		const after = await call("TodoWrite", { todos: [{ id: doomed, status: "deleted" }] });
		expect(subjects(detailsOf(after).tasks)).toEqual(["keep"]);
	});

	it.each(["TaskCreate", "TaskList", "TaskGet"])("%s carries details too", async (name) => {
		const { call } = harness();
		await call("TaskCreate", { subject: "seed" });
		const params = name === "TaskCreate" ? { subject: "another" } : name === "TaskGet" ? { taskId: "1" } : {};
		const result = await call(name, params);
		expect(Array.isArray(detailsOf(result).tasks)).toBe(true);
	});

	// `content` is what the MODEL reads, and these tools promise their rendered
	// text IS the view of the list. Adding `details` must not disturb it.
	it("leaves the model-facing text untouched", async () => {
		const { call } = harness();
		const result = await call("TodoWrite", { todos: [{ subject: "unchanged" }] });
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("unchanged");
	});

	// An empty list is a real answer — "the agent has no plan" — and must not be
	// confused with "this tool reports nothing".
	it("reports an empty list as an empty array, not a missing one", async () => {
		const { call } = harness();
		const result = await call("TaskList", {});
		expect(detailsOf(result).tasks).toEqual([]);
	});
});
