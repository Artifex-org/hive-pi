/**
 * tasks — a durable, model-writable task list.
 *
 * Deliberately NOT a policy on the `agenda` driver and deliberately not an
 * `agent_settled` subscriber: nothing here injects a turn or re-enters the
 * agent loop. That keeps the one-injector invariant untouched, and it is why
 * this extension can land independently of `/loop`.
 *
 * TOOL NAMING. `TodoWrite` is the primary and the only one carrying a
 * `promptSnippet`. The four `Task*` names beside it are compatibility aliases
 * over the same fold, registered because our skill corpus references them
 * heavily (186 `TodoWrite`, 112 `TaskCreate`/`TaskUpdate`, 62 `TaskList`/
 * `TaskGet` across `~/.claude/skills` and the per-repo packs) and a skill that
 * names a tool pi does not have produces a failed call, not a graceful
 * degradation. This is the same argument the knowledge tools make for mirroring the
 * MCP tool names verbatim.
 *
 * The aliases are registered WITHOUT a `promptSnippet` on purpose: pi omits
 * custom tools from the system prompt's tool section when that field is absent
 * (`ToolDefinition.promptSnippet`), so they are callable when a skill names one
 * and invisible when nothing does. Five tools in the schema, one in the prompt.
 *
 * Nothing mutable at module scope — pi builds a fresh jiti per extension entry
 * with `moduleCache:false`, so state lives in the factory closure.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { branchEntries, createBranchWatch } from "../session-branch/branch.ts";
import { LinearClient, tokenFromEnv } from "../status-footer/linear.ts";
import {
	describeHydrate,
	fetchIssueTree,
	linkedTasks,
	planHydrate,
	postComment,
	pushBody,
	resolveIds,
} from "./linear.ts";
import { renderList, renderTaskDetail, renderWriteResult } from "./render.ts";
import {
	applyWrites,
	emptyTasks,
	findTask,
	rehydrateTasks,
	TASKS_ENTRY_TYPE,
	type TaskItem,
	type TaskListState,
	type TaskWrite,
	toEntry,
} from "./state.ts";

const StatusSchema = StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
	description: 'Task status. "deleted" removes the task.',
});

const TaskWriteSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Existing task id. Omit to create a new task." })),
	subject: Type.Optional(Type.String({ description: "Short imperative title. Required when creating." })),
	description: Type.Optional(Type.String({ description: "What needs to be done." })),
	activeForm: Type.Optional(Type.String({ description: 'Present-continuous form, e.g. "Running tests".' })),
	status: Type.Optional(StatusSchema),
	blockedBy: Type.Optional(
		Type.Array(Type.String(), { description: "Task ids this one waits on. Advisory — not enforced." }),
	),
	owner: Type.Optional(
		Type.Union([Type.String(), Type.Null()], { description: "Worker id owning this task. Null clears it." }),
	),
});

/**
 * TaskListDetails is the structured half of a task tool's result.
 *
 * `content` is what the MODEL reads and is deliberately unchanged — these tools
 * promise that their rendered text IS the view of the list, and the model plans
 * against it. `details` is what a RENDERER reads: pi's terminal widget already
 * has the state in process, but anything downstream (the Hive agents workspace)
 * only ever saw the prose, so the list arrived as text to be re-parsed or not
 * understood at all.
 *
 * Emitting the resulting STATE rather than the writes that produced it is the
 * point. A reader wants the current plan and where the agent is in it; the diff
 * of writes tells them almost nothing.
 */
export interface TaskListDetails {
	tasks: readonly TaskItem[];
	/** Writes that did not land. Additive for renderers; absent when clean. */
	problems?: readonly string[];
}

function text(body: string, tasks: readonly TaskItem[] = [], problems?: readonly string[]) {
	const details: TaskListDetails = { tasks, ...(problems && problems.length > 0 ? { problems } : {}) };
	return { content: [{ type: "text" as const, text: body }], details };
}

/**
 * Transcript renderers for the mutating task tools. The deck widget is the
 * task list's display surface, so the transcript shows one quiet line instead
 * of the full echoed list — EXCEPT problems, which must stay loud: a partial
 * apply the user never sees is how a plan silently diverges. UI-only; the
 * model still receives the complete rendered list in `content`.
 */
function renderTaskToolLine(details: TaskListDetails | undefined, theme: Theme): Text {
	const tasks = details?.tasks ?? [];
	const problems = details?.problems ?? [];
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const task of tasks) {
		if (task.status === "pending") pending++;
		else if (task.status === "in_progress") inProgress++;
		else completed++;
	}
	const summary = `⛭ tasks · ${pending} to do · ${inProgress} in progress · ${completed} done`;
	if (problems.length > 0) {
		return new Text(theme.fg("warning", `${summary} · ${problems.length} write(s) did not land`), 0, 0);
	}
	return new Text(theme.fg("dim", summary), 0, 0);
}

export default function (pi: ExtensionAPI) {
	let state: TaskListState = emptyTasks;

	const persist = (next: TaskListState) => {
		state = next;
		try {
			pi.appendEntry(TASKS_ENTRY_TYPE, toEntry(next));
		} catch {
			/* session went away; the in-memory copy still drives this process */
		}
	};

	/**
	 * Cosmetic by definition — never fail a tool call because a widget could
	 * not draw. The deck extension owns the actual `setWidget` slot; this only
	 * states what the list currently is (HIV-1219).
	 */
	const publish = () => {
		try {
			pi.events.emit(DECK_SECTION_CHANNEL, {
				section: "tasks",
				state:
					state.tasks.length === 0
						? null
						: {
								kind: "tasks",
								rows: state.tasks.map((task) => ({
									status: task.status,
									subject: task.subject,
									...(task.activeForm ? { activeForm: task.activeForm } : {}),
									...(task.blockedBy && task.blockedBy.length > 0 ? { blocked: true } : {}),
								})),
							},
			} satisfies DeckSectionEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	pi.events.on(DECK_SYNC_CHANNEL, () => publish());

	const write = (writes: readonly TaskWrite[]) => {
		const result = applyWrites(state, writes, Date.now());
		persist(result.state);
		publish();
		return text(renderWriteResult(result, result.state), result.state.tasks, result.problems);
	};

	/**
	 * Adopt the branch's own list, and repaint.
	 *
	 * The repaint is half the fix, not a nicety: the deck is where the operator
	 * reads the list, so a memory state that moved to the new branch while the
	 * widget still shows the old one has only relocated the lie. Never persists —
	 * the snapshot being adopted is already in the session.
	 */
	const adopt = (entries: readonly unknown[]) => {
		state = rehydrateTasks(entries) ?? emptyTasks;
		publish();
	};

	const branchWatch = createBranchWatch();

	// Registered UNCONDITIONALLY. The factory runs once at startup, so a
	// registration gated on state can never be un-gated by a later command —
	// that is the bug that shipped on 2026-08-05, where telemetry reported "on"
	// and recorded nothing for the rest of the session's life.
	pi.on("session_start", (event, ctx) => {
		const reason = (event as { reason?: string }).reason;
		if (reason === "new") {
			// A fresh session inherits nothing. Every other reason RESTORES: a list
			// that empties on `/reload` is worse than no list at all, because the
			// model reads the absence as "the work is done".
			state = emptyTasks;
			publish();
			return;
		}
		// From the ACTIVE BRANCH, not from every entry in the file: on a session
		// tree the newest snapshot can belong to a branch that was abandoned, and
		// restoring it resurrects todos the operator navigated away from
		// (session-branch/branch.ts).
		try {
			adopt(branchEntries(ctx));
			branchWatch.mark(ctx);
		} catch {
			state = emptyTasks;
			publish();
		}
	});

	/**
	 * Re-derive when the leaf moved, because `/tree` emits no `session_start`.
	 *
	 * Turn start is the moment the list has to be right: it is what the model
	 * will plan against and what the deck will show for the turn. A `null` poll
	 * (branch unchanged, or a ctx that went stale between emit and handler)
	 * leaves the list alone; only a successful read of a branch with no snapshot
	 * empties it, which is what moving to a branch that never had a list means.
	 */
	pi.on("before_agent_start", (_event, ctx) => {
		const entries = branchWatch.poll(ctx);
		if (!entries) return;
		adopt(entries);
	});

	pi.registerTool({
		name: "TodoWrite",
		label: "Tasks",
		description: [
			"Create and update the session task list in one call.",
			"Omit `id` to create; pass `id` to update; pass `status:\"deleted\"` to remove.",
			"Returns the full resulting list — the list is not otherwise visible to you, so this result is the only view of it.",
		].join(" "),
		promptSnippet: "Track multi-step work as a task list the user can see",
		promptGuidelines: [
			"Use TodoWrite for work with three or more distinct steps; mark exactly one task in_progress at a time and complete it before starting the next.",
		],
		parameters: Type.Object({
			todos: Type.Array(TaskWriteSchema, { description: "Tasks to create or update, applied in order." }),
		}),
		renderCall: (_args, theme) => new Text(theme.fg("dim", "⛭ tasks"), 0, 0),
		renderResult: (result, _options, theme) => renderTaskToolLine(result.details as TaskListDetails | undefined, theme),
		async execute(_id, params) {
			return write(params.todos);
		},
	});

	// --- compatibility aliases: no promptSnippet, so they stay out of the prompt ---

	pi.registerTool({
		name: "TaskCreate",
		label: "Create task",
		description: "Add one task to the session task list. Returns the full resulting list.",
		parameters: Type.Object({
			subject: Type.String({ description: "Short imperative title." }),
			description: Type.Optional(Type.String({ description: "What needs to be done." })),
			activeForm: Type.Optional(Type.String({ description: "Present-continuous form." })),
		}),
		renderCall: (_args, theme) => new Text(theme.fg("dim", "⛭ tasks"), 0, 0),
		renderResult: (result, _options, theme) => renderTaskToolLine(result.details as TaskListDetails | undefined, theme),
		async execute(_id, params) {
			return write([params]);
		},
	});

	pi.registerTool({
		name: "TaskUpdate",
		label: "Update task",
		description: "Update one task by id. Returns the full resulting list.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Id of the task to update." }),
			status: Type.Optional(StatusSchema),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.String()),
			owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must finish first." })),
		}),
		renderCall: (_args, theme) => new Text(theme.fg("dim", "⛭ tasks"), 0, 0),
		renderResult: (result, _options, theme) => renderTaskToolLine(result.details as TaskListDetails | undefined, theme),
		async execute(_id, params) {
			const current = findTask(state, params.taskId);
			// Append-only merge: `addBlockedBy` adds, it never replaces. Callers of
			// this alias expect Claude Code's semantics, where the field is additive.
			const blockedBy = params.addBlockedBy
				? Array.from(new Set([...(current?.blockedBy ?? []), ...params.addBlockedBy]))
				: undefined;
			return write([{ ...params, id: params.taskId, blockedBy }]);
		},
	});

	pi.registerTool({
		name: "TaskList",
		label: "List tasks",
		description: "Show the current session task list.",
		parameters: Type.Object({}),
		async execute() {
			return text(renderList(state), state.tasks);
		},
	});

	pi.registerTool({
		name: "TaskGet",
		label: "Get task",
		description: "Show one task's full detail by id.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Id of the task to read." }),
		}),
		async execute(_id, params) {
			const detail = renderTaskDetail(findTask(state, params.taskId));
			if (!detail) return text(`No task with id "${params.taskId}".\n\n${renderList(state)}`, state.tasks);
			return text(detail, state.tasks);
		},
	});

	pi.registerCommand("tasks", {
		description: "Show the task list, hydrate it from Linear (`/tasks linear TES-1234`), or clear it",
		handler: async (args: string, ctx: ExtensionContext) => {
			const raw = args.trim();
			const argument = raw.toLowerCase();

			if (argument.startsWith("linear")) {
				await runLinear(raw.slice("linear".length).trim(), ctx);
				return;
			}

			if (argument === "clear" || argument === "stop" || argument === "off") {
				persist(emptyTasks);
				publish();
				ctx.ui.notify("tasks: list cleared.", "info");
				return;
			}

			if (argument.length > 0) {
				ctx.ui.notify(
					`tasks: unknown argument "${raw}" — try /tasks, /tasks linear <KEY>, /tasks linear push, or /tasks clear.`,
					"warning",
				);
				return;
			}

			ctx.ui.notify(renderList(state, { verbose: true }), "info");
		},
	});

	/**
	 * `/tasks linear <KEY>` reads once; `/tasks linear push` writes once, behind a
	 * confirmation. There is deliberately no watcher and no automatic write: a
	 * continuous mirror has every session racing every other session's writes,
	 * and a crashed run leaves a ticket in a state nobody chose.
	 */
	async function runLinear(argument: string, ctx: ExtensionContext): Promise<void> {
		const token = tokenFromEnv();
		if (!token) {
			ctx.ui.notify("tasks: LINEAR_API_TOKEN is not set — Linear sync is off.", "warning");
			return;
		}
		const client = new LinearClient(token);

		if (argument.toLowerCase() === "push") {
			await pushToLinear(client, ctx);
			return;
		}

		const key = argument.toUpperCase();
		if (!/^[A-Z][A-Z0-9]{1,5}-\d{1,6}$/.test(key)) {
			ctx.ui.notify(`tasks: "${argument}" is not a Linear issue key (expected e.g. TES-1234).`, "warning");
			return;
		}

		let sources: Awaited<ReturnType<typeof fetchIssueTree>>;
		try {
			sources = await fetchIssueTree(client, key);
		} catch (err) {
			// Redacted to the error's name: a fetch error can embed a URL, and a URL
			// can carry a token.
			ctx.ui.notify(`tasks: Linear read failed (${err instanceof Error ? err.name : "error"}).`, "error");
			return;
		}

		if (sources.length === 0) {
			ctx.ui.notify(`tasks: no issue found for ${key}.`, "warning");
			return;
		}

		const plan = planHydrate(state, sources);
		const result = applyWrites(state, plan.writes, Date.now());
		persist(result.state);
		publish();

		const lines = [`tasks: hydrated ${plan.writes.length} item(s) from ${key}.`, ...describeHydrate(plan)];
		if (result.problems.length > 0) for (const problem of result.problems) lines.push(`  ! ${problem}`);
		lines.push("", renderList(result.state));
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function pushToLinear(client: LinearClient, ctx: ExtensionContext): Promise<void> {
		const linked = linkedTasks(state);
		if (linked.length === 0) {
			ctx.ui.notify("tasks: nothing is linked to Linear — run /tasks linear <KEY> first.", "info");
			return;
		}
		const keys = [...new Set(linked.map((task) => task.linearKey as string))];

		// Posting a comment is an outward-facing write to a tracker other people
		// read. Explicit invocation is not the same as informed consent, so the
		// exact targets are shown before anything is sent.
		const ok = await ctx.ui.confirm(
			"Comment on Linear?",
			`A task-status comment will be posted to:\n  ${keys.join("\n  ")}\n\nOne comment per issue.`,
		);
		if (!ok) {
			ctx.ui.notify("tasks: push canceled — nothing was sent.", "info");
			return;
		}

		let ids: Map<string, string>;
		try {
			ids = await resolveIds(client, keys);
		} catch (err) {
			ctx.ui.notify(`tasks: Linear read failed (${err instanceof Error ? err.name : "error"}).`, "error");
			return;
		}

		const posted: string[] = [];
		const failed: string[] = [];
		for (const key of keys) {
			const id = ids.get(key);
			if (!id) {
				failed.push(`${key} (not found)`);
				continue;
			}
			try {
				// Each issue is independent: one failure must not abandon the rest,
				// and a partial push has to report exactly which half landed.
				const success = await postComment(client, id, pushBody(state.tasks, key));
				(success ? posted : failed).push(key);
			} catch (err) {
				failed.push(`${key} (${err instanceof Error ? err.name : "error"})`);
			}
		}

		const lines: string[] = [];
		if (posted.length > 0) lines.push(`tasks: commented on ${posted.join(", ")}.`);
		if (failed.length > 0) lines.push(`tasks: FAILED for ${failed.join(", ")}.`);
		ctx.ui.notify(lines.join("\n"), failed.length > 0 ? "warning" : "info");
	}
}
